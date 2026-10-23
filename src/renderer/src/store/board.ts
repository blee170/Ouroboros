import { create } from 'zustand'
import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type Viewport } from '@xyflow/react'
import { nanoid } from 'nanoid'
import type { AgentStatusPayload, ExternalSessionPayload, HandoffFiredPayload } from '@shared/protocol'
import { normalizeEngine, type AppSettings, type HandoffEdgeData, type NodeData, type NodeKind, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { DEFAULT_HANDOFF_TEMPLATE } from '@shared/handoff'
import { arrangeBoard, defaultSize, placeNew, type Rect } from '@shared/layout'

export type BoardNode = Node<NodeData, 'agent' | 'note' | 'external' | 'browser'>
export type BoardEdge = Edge<HandoffEdgeData & { firing?: boolean }, 'handoff'>

const api = (): Window['ouroboros'] => window.ouroboros

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function rfType(kind: NodeKind): BoardNode['type'] {
  if (kind === 'note') return 'note'
  if (kind === 'external') return 'external'
  if (kind === 'browser') return 'browser'
  return 'agent'
}

/** The rectangle a card really takes on the canvas (its measured size once rendered). */
function rectOf(n: BoardNode): Rect {
  const d = defaultSize(n.data.kind)
  return { x: n.position.x, y: n.position.y, width: n.measured?.width ?? n.width ?? d.width, height: n.measured?.height ?? n.height ?? d.height }
}

function toBoardNode(n: WorkspaceNode): BoardNode {
  return {
    id: n.id,
    type: rfType(n.data.kind),
    position: n.position,
    width: n.width,
    height: n.height,
    dragHandle: '.node-header',
    data: { ...n.data, launchSeq: 0 }
  }
}

interface BoardState {
  projectRoot: string
  /** last successful write of .ouroboros.json (ms) */
  savedAt?: number
  nodes: BoardNode[]
  edges: BoardEdge[]
  settings: AppSettings
  selectedNodeId: string | null
  selectedEdgeId: string | null
  rosterOpen: boolean
  inspectorOpen: boolean
  viewport?: Viewport
  /** When each card last entered "working" (ms). Runtime only (never synced or saved); drives the line glow. */
  workingSince: Record<string, number>
  /** Positions from before the last ⊞ Arrange, until a card is moved, resized, added or closed. */
  arrangeUndo?: Record<string, { x: number; y: number }>
  // actions
  init(): Promise<void>
  openProject(root: string): Promise<void>
  onNodesChange(changes: NodeChange<BoardNode>[]): void
  onEdgesChange(changes: EdgeChange<BoardEdge>[]): void
  onConnect(c: Connection): void
  addNode(kind: NodeKind, partial?: Partial<NodeData> & { id?: string; position?: { x: number; y: number }; select?: boolean }): string
  /** Add a generated set of nodes/edges (Board Builder). `replace` closes every existing card first. */
  addGenerated(nodes: WorkspaceNode[], edges: WorkspaceEdge[], replace: boolean): Promise<void>
  updateNodeData(id: string, patch: Partial<NodeData>): void
  /** Set a card's size (presets, ⤢ button). */
  resizeNode(id: string, width: number, height: number): void
  /** ⊞: lay the cards out in lanes along the lines (workers left, Conductor right, briefs and notes beside it). Undoable until the board changes. */
  arrange(): void
  undoArrange(): void
  updateEdgeData(id: string, patch: Partial<HandoffEdgeData>): void
  removeNode(id: string): Promise<void>
  removeEdge(id: string): void
  /** Edge created by the main process (MCP connect_agents). */
  addEdgeFromMain(edge: WorkspaceEdge): void
  restartNode(id: string): Promise<void>
  select(nodeId: string | null, edgeId: string | null): void
  toggleRoster(): void
  toggleInspector(): void
  setViewport(v: Viewport): void
  setSettings(patch: Partial<AppSettings>): Promise<void>
  applyStatus(p: AgentStatusPayload): void
  applyHandoffFired(p: HandoffFiredPayload): void
  applyExternal(p: ExternalSessionPayload): void
  pullExternal(id: string): void
  persist(): void
}

let syncTimer: ReturnType<typeof setTimeout> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSync(get: () => BoardState): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    const s = get()
    api().board.sync({
      projectRoot: s.projectRoot,
      nodes: s.nodes.filter((n) => n.data.kind !== 'external').map((n) => ({ id: n.id, data: n.data })),
      edges: s.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, data: { mode: e.data?.mode ?? 'auto', template: e.data?.template ?? DEFAULT_HANDOFF_TEMPLATE, condition: e.data?.condition, lastFiredAt: e.data?.lastFiredAt } }))
    })
  }, 150)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => get().persist(), 1000)
}

export const useBoard = create<BoardState>((set, get) => ({
  projectRoot: '',
  nodes: [],
  edges: [],
  settings: DEFAULT_SETTINGS,
  selectedNodeId: null,
  selectedEdgeId: null,
  rosterOpen: true,
  inspectorOpen: true,
  viewport: undefined,
  workingSince: {},

  async init() {
    const settings = await api().settings.get()
    set({ settings })
  },

  async openProject(root) {
    const { workspace, alreadyOpen } = await api().workspace.load(root)
    if (alreadyOpen) return // another window has it and was focused
    const nodes = (workspace?.nodes ?? []).map(toBoardNode)
    const edges: BoardEdge[] = (workspace?.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'handoff', data: { ...e.data } }))
    set({ projectRoot: root, nodes, edges, viewport: workspace?.viewport, selectedNodeId: null, selectedEdgeId: null, workingSince: {} })
    scheduleSync(get)
  },

  onNodesChange(changes) {
    const moved = changes.some((c) => c.type === 'position' || c.type === 'remove' || (c.type === 'dimensions' && c.resizing))
    set(moved && get().arrangeUndo ? { nodes: applyNodeChanges(changes, get().nodes), arrangeUndo: undefined } : { nodes: applyNodeChanges(changes, get().nodes) })
    if (changes.some((c) => c.type !== 'select' && c.type !== 'dimensions')) scheduleSync(get)
    else if (changes.some((c) => c.type === 'dimensions')) scheduleSync(get)
  },
  onEdgesChange(changes) {
    set({ edges: applyEdgeChanges(changes, get().edges) })
    if (changes.some((c) => c.type !== 'select')) scheduleSync(get)
  },
  onConnect(c) {
    if (!c.source || !c.target || c.source === c.target) return
    const edge: BoardEdge = { id: nanoid(8), source: c.source, target: c.target, type: 'handoff', data: { mode: 'auto', template: DEFAULT_HANDOFF_TEMPLATE } }
    set({ edges: addEdge(edge, get().edges) })
    scheduleSync(get)
  },

  addNode(kind, partial = {}) {
    const id = partial.id ?? nanoid(10)
    const s = get()
    const cwd = partial.cwd ?? s.projectRoot
    const isNote = kind === 'note'
    const isBrowser = kind === 'browser'
    const size = { width: isNote ? 300 : isBrowser ? 640 : 560, height: isNote ? 220 : isBrowser ? 480 : 400 }
    // the first grid cell nothing overlaps: a closed card frees its cell, a resized one keeps new cards out
    const position = partial.position ?? placeNew(s.nodes.filter((n) => n.data.kind !== 'external').map(rectOf), size)
    const titleDefault = kind === 'conductor' ? 'Conductor' : kind === 'note' ? 'Note' : kind === 'browser' ? 'Browser' : kind === 'command' ? 'Command' : basename(cwd)
    const { position: _p, id: _id, select = true, ...rest } = partial
    const data: NodeData = {
      kind,
      title: rest.title ?? titleDefault,
      cwd,
      note: isNote ? (rest.note ?? '') : undefined,
      url: isBrowser ? (rest.url ?? s.settings.browserHome ?? 'https://www.google.com') : undefined,
      claude: kind === 'claude' || kind === 'conductor' ? { ...(rest.claude ?? {}) } : undefined,
      ...rest,
      // engine: explicit > settings default; claude is stored as undefined
      // engine: an explicit value (including 'claude') wins; otherwise the settings default
      engine: kind === 'claude' || kind === 'conductor' ? normalizeEngine(rest.engine !== undefined ? rest.engine : s.settings.defaultEngine) : undefined,
      createdAt: rest.createdAt ?? Date.now(),
      launchSeq: 0
    }
    const node: BoardNode = {
      id,
      type: rfType(kind),
      position,
      ...size,
      dragHandle: '.node-header',
      data
    }
    set(select ? { nodes: [...s.nodes, node], selectedNodeId: id, selectedEdgeId: null, arrangeUndo: undefined } : { nodes: [...s.nodes, node], arrangeUndo: undefined })
    scheduleSync(get)
    return id
  },

  async addGenerated(generated, generatedEdges, replace) {
    const s = get()
    if (replace) {
      for (const n of s.nodes) if (n.data.kind === 'terminal' || n.data.kind === 'claude' || n.data.kind === 'conductor' || n.data.kind === 'command') await api().pty.kill(n.id)
    }
    const keep = replace ? [] : s.nodes
    const keepEdges = replace ? [] : s.edges
    const def = normalizeEngine(s.settings.defaultEngine)
    const nodes = generated.map((n) => (n.data.kind === 'claude' || n.data.kind === 'conductor') && !n.data.engine && def ? { ...n, data: { ...n.data, engine: def } } : n).map(toBoardNode)
    const edges: BoardEdge[] = generatedEdges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'handoff', data: { ...e.data } }))
    set({ nodes: [...keep, ...nodes], edges: [...keepEdges, ...edges], selectedNodeId: null, selectedEdgeId: null, arrangeUndo: undefined })
    scheduleSync(get)
  },

  updateNodeData(id, patch) {
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)) })
    scheduleSync(get)
  },
  resizeNode(id, width, height) {
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, width, height, style: { ...(n.style ?? {}), width, height } } : n)), arrangeUndo: undefined })
    scheduleSync(get)
  },
  arrange() {
    const s = get()
    const cards = s.nodes.filter((n) => n.data.kind !== 'external')
    if (!cards.length) return
    const pos = arrangeBoard(
      cards.map((n) => ({ id: n.id, kind: n.data.kind, title: n.data.title, width: rectOf(n).width, height: rectOf(n).height })),
      s.edges.map((e) => ({ source: e.source, target: e.target }))
    )
    const before = Object.fromEntries(cards.map((n) => [n.id, { ...n.position }]))
    set({ nodes: s.nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)), arrangeUndo: before })
    scheduleSync(get)
  },
  undoArrange() {
    const before = get().arrangeUndo
    if (!before) return
    set({ nodes: get().nodes.map((n) => (before[n.id] ? { ...n, position: before[n.id] } : n)), arrangeUndo: undefined })
    scheduleSync(get)
  },
  updateEdgeData(id, patch) {
    set({ edges: get().edges.map((e) => (e.id === id ? { ...e, data: { ...(e.data ?? { mode: 'auto', template: DEFAULT_HANDOFF_TEMPLATE }), ...patch } } : e)) })
    scheduleSync(get)
  },

  async removeNode(id) {
    const n = get().nodes.find((x) => x.id === id)
    if (n && (n.data.kind === 'terminal' || n.data.kind === 'claude' || n.data.kind === 'conductor' || n.data.kind === 'command')) await api().pty.kill(id)
    set({ nodes: get().nodes.filter((x) => x.id !== id), edges: get().edges.filter((e) => e.source !== id && e.target !== id), selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId, arrangeUndo: undefined })
    scheduleSync(get)
  },
  removeEdge(id) {
    set({ edges: get().edges.filter((e) => e.id !== id), selectedEdgeId: null })
    scheduleSync(get)
  },
  addEdgeFromMain(edge) {
    if (get().edges.some((e) => e.id === edge.id)) return
    set({ edges: [...get().edges, { id: edge.id, source: edge.source, target: edge.target, type: 'handoff', data: { ...edge.data } }] })
    scheduleSync(get)
  },

  async restartNode(id) {
    await api().pty.kill(id)
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, launchSeq: (Number(n.data.launchSeq) || 0) + 1, status: 'starting', statusDetail: 'restarting' } } : n)) })
  },

  select(nodeId, edgeId) {
    // React Flow keeps its own `selected` flags: without this the last clicked card keeps its border and
    // resizer, and clicking it again fires no selection change
    const s = get()
    set({
      selectedNodeId: nodeId,
      selectedEdgeId: edgeId,
      nodes: s.nodes.map((n) => (Boolean(n.selected) === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId })),
      edges: s.edges.map((e) => (Boolean(e.selected) === (e.id === edgeId) ? e : { ...e, selected: e.id === edgeId }))
    })
  },
  toggleRoster() {
    set({ rosterOpen: !get().rosterOpen })
  },
  toggleInspector() {
    set({ inspectorOpen: !get().inspectorOpen })
  },
  setViewport(v) {
    set({ viewport: v })
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => get().persist(), 1500)
  },
  async setSettings(patch) {
    const settings = await api().settings.set(patch)
    set({ settings })
  },

  applyStatus(p) {
    // when the turn started; a permission prompt or question (needs-you) pauses the turn without ending it
    let workingSince = get().workingSince
    if (p.status === 'working' && !(p.nodeId in workingSince)) workingSince = { ...workingSince, [p.nodeId]: p.at }
    else if (p.status !== 'working' && p.status !== 'needs-you' && p.nodeId in workingSince) {
      workingSince = { ...workingSince }
      delete workingSince[p.nodeId]
    }
    set({
      workingSince,
      nodes: get().nodes.map((n) =>
        n.id === p.nodeId
          ? { ...n, data: { ...n.data, status: p.status, statusDetail: p.statusDetail ?? n.data.statusDetail, sessionId: p.sessionId ?? n.data.sessionId, lastAssistantMessage: p.lastAssistantMessage ?? n.data.lastAssistantMessage, lastEventAt: p.at } }
          : n
      )
    })
  },
  applyHandoffFired(p) {
    set({ edges: get().edges.map((e) => (e.id === p.edgeId ? { ...e, data: { ...(e.data as HandoffEdgeData), lastFiredAt: p.at, firing: true } } : e)) })
    setTimeout(() => set({ edges: get().edges.map((e) => (e.id === p.edgeId ? { ...e, data: { ...(e.data as HandoffEdgeData), firing: false } } : e)) }), 2000)
  },
  applyExternal(p) {
    const id = `ext:${p.sessionId}`
    const existing = get().nodes.find((n) => n.id === id)
    if (p.status === 'ended') {
      if (existing) set({ nodes: get().nodes.filter((n) => n.id !== id) })
      return
    }
    if (existing) {
      set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, status: p.status, statusDetail: p.statusDetail, lastAssistantMessage: p.lastAssistantMessage ?? n.data.lastAssistantMessage, lastEventAt: p.at, cwd: p.cwd || n.data.cwd } } : n)) })
      return
    }
    const count = get().nodes.filter((n) => n.data.kind === 'external').length
    const node: BoardNode = {
      id,
      type: 'external',
      position: { x: -360, y: 80 + count * 150 },
      width: 300,
      height: 130,
      dragHandle: '.node-header',
      data: { kind: 'external', title: basename(p.cwd || 'external session'), cwd: p.cwd, sessionId: p.sessionId, status: p.status, statusDetail: p.statusDetail, lastAssistantMessage: p.lastAssistantMessage, lastEventAt: p.at }
    }
    set({ nodes: [...get().nodes, node] })
  },
  pullExternal(id) {
    const n = get().nodes.find((x) => x.id === id)
    if (!n || n.data.kind !== 'external' || !n.data.sessionId) return
    // already on the board as a real card? just drop the external shadow
    if (get().nodes.some((x) => x.id !== id && x.data.sessionId === n.data.sessionId)) {
      set({ nodes: get().nodes.filter((x) => x.id !== id) })
      return
    }
    get().addNode('claude', { cwd: n.data.cwd, title: n.data.title, engine: 'claude', claude: { resume: n.data.sessionId } })
    set({ nodes: get().nodes.filter((x) => x.id !== id) })
  },

  persist() {
    const s = get()
    if (!s.projectRoot) return
    const ws: Workspace = {
      version: 1,
      projectRoot: s.projectRoot,
      viewport: s.viewport,
      nodes: s.nodes
        .filter((n) => n.data.kind !== 'external')
        .map((n) => {
          const { launchSeq: _l, ...data } = n.data
          return { id: n.id, position: n.position, width: n.measured?.width ?? n.width, height: n.measured?.height ?? n.height, data }
        }),
      edges: s.edges.map((e) => {
        const { firing: _f, ...data } = (e.data ?? { mode: 'auto', template: DEFAULT_HANDOFF_TEMPLATE }) as HandoffEdgeData & { firing?: boolean }
        return { id: e.id, source: e.source, target: e.target, data }
      })
    }
    void api().workspace.save(ws).then(() => set({ savedAt: Date.now() }))
  }
}))

// Exposed for smoke tests and quick debugging from DevTools.
;(window as unknown as { __board: typeof useBoard }).__board = useBoard
