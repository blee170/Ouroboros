import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { diffPrivileges, privilegeView, type HeldCard, type PrivilegeView, type TrustEdge, type TrustNode } from '@shared/board-trust'

interface Entry {
  sha256: string
  views: Record<string, PrivilegeView>
}

/** One key per folder however it was reached (case, 8.3 names, junctions, subst drives). */
function keyOf(projectRoot: string): string {
  let p = resolve(projectRoot)
  try {
    p = realpathSync.native(p)
  } catch {
    /* a folder that is gone keys by its resolved path */
  }
  return p.toLowerCase()
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

function isEntry(v: unknown): v is Entry {
  return Boolean(v) && typeof v === 'object' && typeof (v as Entry).sha256 === 'string' && Boolean((v as Entry).views) && typeof (v as Entry).views === 'object'
}

function parseBoard(text: string): { nodes: TrustNode[]; edges: TrustEdge[] } | undefined {
  try {
    const ws = JSON.parse(text) as { nodes?: unknown; edges?: unknown }
    return { nodes: Array.isArray(ws.nodes) ? (ws.nodes as TrustNode[]) : [], edges: Array.isArray(ws.edges) ? (ws.edges as TrustEdge[]) : [] }
  } catch {
    return undefined
  }
}

/**
 * What the app last wrote to each project's board file (hash + every card's privilege fields), kept in the app's
 * data folder. A card can still write that folder as the same OS user, so this raises the bar, it is not a boundary.
 * A card held at open keeps its trusted view in the record until the owner decides, so an app save in between
 * cannot launder the outside change.
 */
export class BoardTrust {
  private entries: Record<string, Entry> = {}
  private held = new Map<string, Map<string, PrivilegeView>>()

  constructor(private file: string, private log: (line: string) => void = () => {}) {
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object') for (const [k, v] of Object.entries(parsed)) if (isEntry(v)) this.entries[k] = v
    } catch (err) {
      this.log(`board trust record unreadable (${(err as Error).message}): boards opened before are re-checked as new`)
    }
  }

  /**
   * The app wrote `text` to `projectRoot`'s board file. `fromDisk`: the nodes in it came from the file, not from the
   * app (the ledger writer re-reads the board to add tasks), so they prove nothing: the trusted views stay, and the
   * hash is kept only when the file still matches them.
   */
  record(projectRoot: string, text: string, opts: { fromDisk?: boolean } = {}): void {
    const key = keyOf(projectRoot)
    const board = parseBoard(text)
    if (!board) return
    const held = this.held.get(key)
    const prior = this.entries[key]
    const views: Record<string, PrivilegeView> = {}
    let clean = !held?.size
    for (const n of board.nodes) {
      if (!n || typeof n.id !== 'string') continue
      if (opts.fromDisk || held?.has(n.id)) {
        const v = prior?.views[n.id] ?? held?.get(n.id)
        if (v) views[n.id] = v
      } else views[n.id] = privilegeView(n.data, n.id, board.edges)
    }
    if (opts.fromDisk) clean = clean && Boolean(prior) && diffPrivileges(prior!.views, board.nodes, board.edges).length === 0
    // a file holding untrusted values gets no matching hash, so the next open compares again
    this.entries[key] = { sha256: clean ? sha(text) : '', views }
    this.save()
  }

  /**
   * At open: the cards to hold. An unchanged hash holds nothing. A board with no record is trusted as found only when
   * the owner opened that folder before (an older version wrote it); a folder never opened (a cloned repo with a
   * board file in it) is checked as all-new, so a card that raises rights is held. Anything unexpected holds every card.
   */
  check(projectRoot: string, text: string, knownProject: boolean): HeldCard[] {
    const key = keyOf(projectRoot)
    this.held.delete(key)
    const board = parseBoard(text)
    const entry = this.entries[key]
    let held: HeldCard[]
    try {
      if (!board) throw new Error('board file is not JSON')
      if (!entry && knownProject) {
        this.record(projectRoot, text)
        return []
      }
      if (entry && entry.sha256 && entry.sha256 === sha(text)) return []
      held = diffPrivileges(entry?.views ?? {}, board.nodes, board.edges)
    } catch (err) {
      this.log(`board trust check failed for ${projectRoot} (${(err as Error).message}): holding every card`)
      held = (board?.nodes ?? []).filter((n) => n && typeof n.id === 'string').map((n) => ({ nodeId: n.id, title: String(n.data?.title ?? n.id).slice(0, 120), added: !entry?.views[n.id], changes: [] }))
    }
    if (held.length) {
      this.held.set(key, new Map(held.map((h) => [h.nodeId, entry?.views[h.nodeId] ?? {}])))
      this.log(`board file ${projectRoot} changed outside Ouroboros: holding ${held.map((h) => h.nodeId).join(', ')}`)
    }
    if (!entry) this.record(projectRoot, text)
    return held
  }

  isHeld(projectRoot: string | undefined, nodeId: string): boolean {
    return Boolean(projectRoot && this.held.get(keyOf(projectRoot))?.has(nodeId))
  }

  /**
   * The owner decided. Trust: the cards are recorded as they are in `text` (the file now). Revert: the trusted views
   * are returned and stay in the record; the renderer puts them back and its save records the result.
   */
  release(projectRoot: string, nodeIds: string[], revert: boolean, text?: string): Record<string, PrivilegeView> {
    const key = keyOf(projectRoot)
    const held = this.held.get(key)
    const out: Record<string, PrivilegeView> = {}
    for (const id of nodeIds) {
      const v = held?.get(id)
      if (!v) continue
      out[id] = v
      held!.delete(id)
    }
    if (!revert && text !== undefined) {
      const board = parseBoard(text)
      const entry = this.entries[key] ?? { sha256: '', views: {} }
      for (const n of board?.nodes ?? []) if (n && out[n.id]) entry.views[n.id] = privilegeView(n.data, n.id, board!.edges)
      this.entries[key] = { ...entry, sha256: '' }
      this.save()
    }
    return out
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.entries), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      this.log(`board trust not saved: ${(err as Error).message}`)
    }
  }
}
