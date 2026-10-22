import { EventEmitter } from 'node:events'
import type { AgentSnapshot, AgentStatus, HookEvent, NodeData, WorkspaceEdge } from '@shared/types'
import type { AgentStatusPayload, BoardSyncPayload, ExternalSessionPayload } from '@shared/protocol'
import { reduceHook } from '@shared/status'

const OUTPUT_CAP = 200_000

export interface NodeMeta {
  id: string
  data: NodeData
}

export interface ExternalSession {
  sessionId: string
  cwd: string
  status: AgentStatus
  statusDetail?: string
  lastAssistantMessage?: string
  at: number
}

/**
 * Authoritative runtime board state kept in the main process so that hooks, handoffs,
 * the MCP server and the renderer all see the same thing.
 */
export class Board extends EventEmitter {
  projectRoot = ''
  nodes = new Map<string, NodeMeta>()
  edges: WorkspaceEdge[] = []
  private output = new Map<string, string>()
  private sessionToNode = new Map<string, string>()
  externalSessions = new Map<string, ExternalSession>()
  ptyAlive = new Set<string>()

  sync(payload: BoardSyncPayload): void {
    this.projectRoot = payload.projectRoot
    const next = new Map<string, NodeMeta>()
    for (const n of payload.nodes) {
      const prev = this.nodes.get(n.id)
      const data: NodeData = { ...n.data }
      if (prev) {
        // keep runtime fields that the renderer does not own
        data.status = prev.data.status ?? data.status
        data.statusDetail = prev.data.statusDetail ?? data.statusDetail
        data.lastAssistantMessage = prev.data.lastAssistantMessage ?? data.lastAssistantMessage
        data.lastEventAt = prev.data.lastEventAt ?? data.lastEventAt
        data.sessionId = data.sessionId ?? prev.data.sessionId
      }
      next.set(n.id, { id: n.id, data })
      if (data.sessionId) this.sessionToNode.set(data.sessionId, n.id)
    }
    for (const id of this.nodes.keys()) {
      if (!next.has(id)) this.output.delete(id)
    }
    this.nodes = next
    this.edges = payload.edges
  }

  appendOutput(nodeId: string, chunk: string): void {
    const prev = this.output.get(nodeId) ?? ''
    let buf = prev + chunk
    if (buf.length > OUTPUT_CAP) buf = buf.slice(buf.length - OUTPUT_CAP)
    this.output.set(nodeId, buf)
  }

  getOutput(nodeId: string): string {
    return this.output.get(nodeId) ?? ''
  }

  setPtyAlive(nodeId: string, alive: boolean): void {
    if (alive) this.ptyAlive.add(nodeId)
    else this.ptyAlive.delete(nodeId)
  }

  nodeForSession(sessionId: string): string | undefined {
    return this.sessionToNode.get(sessionId)
  }

  setStatus(nodeId: string, patch: Partial<AgentStatusPayload> & { status: AgentStatus }): void {
    const n = this.nodes.get(nodeId)
    const at = Date.now()
    if (n) {
      n.data.status = patch.status
      if (patch.statusDetail !== undefined) n.data.statusDetail = patch.statusDetail
      if (patch.lastAssistantMessage !== undefined) n.data.lastAssistantMessage = patch.lastAssistantMessage
      if (patch.sessionId) {
        n.data.sessionId = patch.sessionId
        this.sessionToNode.set(patch.sessionId, nodeId)
        this.dropExternal(patch.sessionId)
      }
      n.data.lastEventAt = at
    }
    const payload: AgentStatusPayload = {
      nodeId,
      status: patch.status,
      statusDetail: patch.statusDetail,
      sessionId: patch.sessionId,
      lastAssistantMessage: patch.lastAssistantMessage,
      at
    }
    this.emit('status', payload)
  }

  /** A session we launched also fired the global hook before we knew its id: remove the stray external card. */
  private dropExternal(sessionId: string): void {
    const ext = this.externalSessions.get(sessionId)
    if (!ext) return
    this.externalSessions.delete(sessionId)
    const payload: ExternalSessionPayload = { ...ext, status: 'ended', statusDetail: 'claimed by a card', at: Date.now() }
    this.emit('external', payload)
  }

  /** Apply a hook event addressed to a known node. Returns the status update if any. */
  applyHook(nodeId: string, event: HookEvent): void {
    const n = this.nodes.get(nodeId)
    const update = reduceHook(n?.data.status, event)
    this.emit('hook', { nodeId, event })
    if (n && typeof event.session_id === 'string' && !n.data.sessionId) {
      n.data.sessionId = event.session_id
      this.sessionToNode.set(event.session_id, nodeId)
      this.dropExternal(event.session_id)
    }
    if (!update) return
    this.setStatus(nodeId, update)
    if (event.hook_event_name === 'Stop') {
      this.emit('stop', nodeId, update.lastAssistantMessage ?? '')
    }
  }

  /** Apply a hook event that came from the global (external) hook. */
  applyExternalHook(event: HookEvent): void {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
    if (!sessionId) return
    // Sessions we launched ourselves also fire the global hook; ignore those.
    if (this.sessionToNode.has(sessionId)) return
    const prev = this.externalSessions.get(sessionId)
    const update = reduceHook(prev?.status, event)
    if (!update) return
    const entry: ExternalSession = {
      sessionId,
      cwd: typeof event.cwd === 'string' ? event.cwd : (prev?.cwd ?? ''),
      status: update.status,
      statusDetail: update.statusDetail ?? prev?.statusDetail,
      lastAssistantMessage: update.lastAssistantMessage ?? prev?.lastAssistantMessage,
      at: Date.now()
    }
    if (update.status === 'ended') this.externalSessions.delete(sessionId)
    else this.externalSessions.set(sessionId, entry)
    const payload: ExternalSessionPayload = { ...entry }
    this.emit('external', payload)
  }

  snapshot(): AgentSnapshot[] {
    const out: AgentSnapshot[] = []
    for (const n of this.nodes.values()) {
      if (n.data.kind === 'note' || n.data.kind === 'browser') continue // command cards are agents too
      out.push({
        id: n.id,
        kind: n.data.kind,
        title: n.data.title,
        cwd: n.data.cwd,
        status: n.data.status ?? (this.ptyAlive.has(n.id) ? 'idle' : 'ended'),
        statusDetail: n.data.statusDetail,
        sessionId: n.data.sessionId,
        lastAssistantMessage: n.data.lastAssistantMessage,
        lastEventAt: n.data.lastEventAt,
        ptyAlive: this.ptyAlive.has(n.id)
      })
    }
    return out
  }
}
