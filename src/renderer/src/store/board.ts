import { create } from 'zustand'
import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type Viewport } from '@xyflow/react'
import { nanoid } from 'nanoid'
import type { ActivityPayload, AgentStatusPayload, ExternalSessionPayload, HandoffFiredPayload, SessionUsage, UpdateStatus } from '@shared/protocol'
import type { UsageSnapshot } from '@shared/usage'
import type { AutonomyPublic } from '@shared/autonomy'
import type { Task } from '@shared/ledger'
import { revertPrivileges, trustedIncoming, type HeldCard } from '@shared/board-trust'
import type { Mail } from '@shared/mail'
import type { Approval } from '@shared/gate'
import type { Decision } from '@shared/decisions'
import type { GrokHandoff } from '@shared/grokbot'
import { normalizeEngine, type AppSettings, type HandoffEdgeData, type NodeData, type NodeKind, type Workspace, type WorkspaceEdge, type WorkspaceNode } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { DEFAULT_HANDOFF_TEMPLATE } from '@shared/handoff'
import { arrangeBoard, defaultSize, placeBeside, placeNew, type Rect } from '@shared/layout'
import { EMPTY_ATTENTION, onStatus as attentionOnStatus, onViewed, type Attention } from '@shared/attention'
import { SETTLE_ROWS_MS, rosterSnapshot, sameIds, sameRoster, type RosterRow } from '@shared/roster'
import { DONE_ECHO_DETAIL } from '@shared/status'

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
  /** The last save's error, until a save succeeds (OneDrive or antivirus locks make renameSync fail on Windows). */
  saveError?: string
  nodes: BoardNode[]
  edges: BoardEdge[]
  settings: AppSettings
  /** false until the saved settings arrived from main: before that `settings` is only the defaults */
  settingsLoaded: boolean
  selectedNodeId: string | null
  selectedEdgeId: string | null
  rosterOpen: boolean
  inspectorOpen: boolean
  viewport?: Viewport
  /** When each card last entered "working" (ms). Runtime only (never synced or saved); drives the line glow. */
  workingSince: Record<string, number>
  /** Positions from before the last ⊞ Arrange, until a card is moved, resized, added or closed. */
  arrangeUndo?: Record<string, { x: number; y: number }>
  /** This window's Autonomous mode run, as main reports it. */
  autonomy: AutonomyPublic
  /** The project's task ledger, as main pushes it (the renderer never edits it directly). */
  tasks: Task[]
  /** Cards not launched because the board file was changed outside Ouroboros (main refuses them until the owner decides). */
  held: HeldCard[]
  /** The project mailbox, as main pushes it (unacknowledged messages of the last week). */
  mail: Mail[]
  /** the action gate's requests to the owner (autonomous runs) */
  approvals: Approval[]
  /** questions cards asked the owner (ask_owner) */
  decisions: Decision[]
  /** Grok Bot handoffs cards asked for (pending ones wait for Send / Discard in the Today tab) */
  grokHandoffs: GrokHandoff[]
  /** What the right panel shows. */
  rpanelTab: 'inspector' | 'tasks' | 'today'
  /** The updater's last word, kept here so the status bar sees an update found before a project was open. */
  updateStatus: UpdateStatus | null
  /** Unread results and reviewed turns (shared/attention): runtime only. */
  attention: Attention
  /**
   * The sidebar rows as last settled: a card added or closed shows at once, a card that changed section moves
   * SETTLE_ROWS_MS later, so rows do not jump under the pointer on every event. Ctrl+1…9 follow this order.
   */
  settledRoster: RosterRow[]
  /** Context usage per Claude card (from its transcript), refreshed when the card's status changes. */
  usage: Record<string, SessionUsage>
  /** Account usage per engine (plan windows, tokens), as main last reported it. */
  accountUsage: UsageSnapshot | null
  /** The Usage dialog (title bar button, status-bar chip). */
  usageOpen: boolean
  // actions
  setAutonomy(p: AutonomyPublic): void
  setTasks(t: Task[]): void
  setMail(m: Mail[]): void
  setApprovals(a: Approval[]): void
  setDecisions(d: Decision[]): void
  setGrokHandoffs(h: GrokHandoff[]): void
  /** The owner's call on held cards: trust the change as it is, or put the values the app last wrote back. Either way they launch. */
  resolveHeld(ids: string[], revert: boolean): Promise<void>
  /** Show a tab of the right panel (opening the panel when it is closed). */
  showRpanel(tab: 'inspector' | 'tasks' | 'today'): void
  setUpdateStatus(p: UpdateStatus): void
  setAccountUsage(s: UsageSnapshot): void
  setUsageOpen(open: boolean): void
  /** The owner looked at a card (selected it while the window has focus): unread goes, a finished turn reads idle. */
  markViewed(id: string): void
  setUsage(id: string, u: SessionUsage): void
  init(): Promise<void>
  openProject(root: string): Promise<void>
  onNodesChange(changes: NodeChange<BoardNode>[]): void
  onEdgesChange(changes: EdgeChange<BoardEdge>[]): void
  onConnect(c: Connection): void
  addNode(kind: NodeKind, partial?: Partial<NodeData> & { id?: string; position?: { x: number; y: number }; select?: boolean; near?: string }): string
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
  /** Runtime only: no sync back to main, no save. */
  applyActivity(p: ActivityPayload): void
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
  settingsLoaded: false,
  selectedNodeId: null,
  selectedEdgeId: null,
  rosterOpen: true,
  inspectorOpen: true,
  viewport: undefined,
  workingSince: {},
  autonomy: { on: false, dispatches: 0, parked: [] },
  setAutonomy(p) {
    set({ autonomy: p })
  },
  tasks: [],
  held: [],
  mail: [],
  approvals: [],
  decisions: [],
  grokHandoffs: [],
  rpanelTab: 'inspector',
  async resolveHeld(ids, revert) {
    const views = await api().workspace.trust(ids, revert)
    const done = new Set(ids)
    const added = new Set(get().held.filter((h) => done.has(h.nodeId) && h.added).map((h) => h.nodeId))
    // Revert: a card the app never wrote has nothing to go back to and is removed; a known card gets its trusted
    // fields back and loses incoming handoff lines that were not in the board the app saved
    const removed = revert ? added : new Set<string>()
    const keepLine = (e: BoardEdge): boolean => {
      if (removed.has(e.source) || removed.has(e.target)) return false
      if (!revert || !done.has(e.target) || !views[e.target]) return true
      return trustedIncoming(views[e.target]).some((l) => l.from === e.source && l.mode === (e.data?.mode ?? 'auto') && l.template === (e.data?.template ?? ''))
    }
    set({
      held: get().held.filter((h) => !done.has(h.nodeId)),
      edges: get().edges.filter(keepLine),
      nodes: get()
        .nodes.filter((n) => !removed.has(n.id))
        .map((n) => {
          if (!done.has(n.id)) return n
          const data = revert && views[n.id] ? revertPrivileges(n.data, views[n.id]) : n.data
          return { ...n, data: { ...data, launchSeq: (Number(n.data.launchSeq) || 0) + 1, status: 'starting', statusDetail: 'starting' } }
        })
    })
    scheduleSync(get)
  },
  setApprovals(a) {
    set({ approvals: a })
  },
  setDecisions(d) {
    set({ decisions: d })
  },
  setGrokHandoffs(h) {
    set({ grokHandoffs: h })
  },
  setMail(m) {
    set({ mail: m })
  },
  setTasks(t) {
    set({ tasks: t })
  },
  showRpanel(tab) {
    set({ rpanelTab: tab, inspectorOpen: true })
  },
  updateStatus: null,
  setUpdateStatus(p) {
    set({ updateStatus: p })
  },
  attention: EMPTY_ATTENTION,
  settledRoster: [],
  usage: {},
  accountUsage: null,
  usageOpen: false,
  setAccountUsage(s) {
    set({ accountUsage: s })
  },
  setUsageOpen(open) {
    set({ usageOpen: open })
  },
  markViewed(id) {
    const s = get()
    const n = s.nodes.find((x) => x.id === id)
    // an external session's status is written straight from its hooks (applyExternal), outside this model
    if (!n || n.data.kind === 'external') return
    const { attention, shown } = onViewed(s.attention, id, n.data.status)
    if (attention === s.attention && shown === n.data.status) return
    set({ attention, nodes: shown === n.data.status ? s.nodes : s.nodes.map((x) => (x.id === id ? { ...x, data: { ...x.data, status: shown } } : x)) })
  },
  setUsage(id, u) {
    set({ usage: { ...get().usage, [id]: u } })
  },

  async init() {
    const settings = await api().settings.get()
    set({ settings, settingsLoaded: true })
  },

  async openProject(root) {
    const { workspace, alreadyOpen, held } = await api().workspace.load(root)
    if (alreadyOpen) return // another window has it and was focused
    const nodes = (workspace?.nodes ?? []).map(toBoardNode)
    const edges: BoardEdge[] = (workspace?.edges ?? []).map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'handoff', data: { ...e.data } }))
    set({ projectRoot: root, nodes, edges, viewport: workspace?.viewport, selectedNodeId: null, selectedEdgeId: null, workingSince: {}, attention: EMPTY_ATTENTION, usage: {}, tasks: [], held: held ?? [] })
    scheduleSync(get)
    // main loaded the ledger with the board file; a push follows every later change
    void api()
      .tasks.list()
      .then((t) => set({ tasks: t }))
    void api()
      .mail.list()
      .then((m) => set({ mail: m }))
    void api()
      .gate.list()
      .then((a) => set({ approvals: a }))
    void api()
      .decisions.list()
      .then((d) => set({ decisions: d }))
    void api()
      .grokBot.list()
      .then((h) => set({ grokHandoffs: h }))
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
    const occupied = s.nodes.filter((n) => n.data.kind !== 'external').map(rectOf)
    const anchor = partial.near ? s.nodes.find((n) => n.id === partial.near) : undefined
    const position = partial.position ?? (anchor ? placeBeside(rectOf(anchor), occupied, size) : placeNew(occupied, size))
    const titleDefault = kind === 'conductor' ? 'Conductor' : kind === 'note' ? 'Note' : kind === 'browser' ? 'Browser' : kind === 'command' ? 'Command' : basename(cwd)
    const { position: _p, id: _id, select = true, near: _near, ...rest } = partial
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
    // selecting a card while the window has focus is looking at it
    if (nodeId && document.hasFocus()) get().markViewed(nodeId)
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
    const s = get()
    const prev = s.nodes.find((n) => n.id === p.nodeId)
    // a finished turn is "done" only until the owner looks at the card; looking = selected while the window has focus
    const viewing = s.selectedNodeId === p.nodeId && document.hasFocus()
    const { attention, shown } = attentionOnStatus(s.attention, p.nodeId, prev?.data.status, p.status, p.at, viewing, p.statusDetail === DONE_ECHO_DETAIL)
    set({
      workingSince,
      attention,
      nodes: s.nodes.map((n) =>
        n.id === p.nodeId
          ? { ...n, data: { ...n.data, status: shown, statusDetail: p.statusDetail ?? n.data.statusDetail, sessionId: p.sessionId ?? n.data.sessionId, lastAssistantMessage: p.lastAssistantMessage ?? n.data.lastAssistantMessage, lastEventAt: p.at } }
          : n
      )
    })
  },
  applyActivity(p) {
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== p.nodeId) return n
        const data = { ...n.data }
        if (p.doing !== undefined) data.doing = p.doing ?? undefined
        if (p.topic !== undefined) data.topic = p.topic
        return { ...n, data }
      })
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
    void api().workspace.save(ws).then(
      () => set({ savedAt: Date.now(), saveError: undefined }),
      (err: unknown) => set({ saveError: err instanceof Error ? err.message : String(err) })
    )
  }
}))

// Main holds back the toast and the voice for the selected card, however it got selected (a click, a hotkey,
// a new card, a closed one).
useBoard.subscribe((s, prev) => {
  if (s.selectedNodeId !== prev.selectedNodeId) api().board.setSelected(s.selectedNodeId)
})

// The settled sidebar: rows move to a new section SETTLE_ROWS_MS after the first pending change (at most that
// late, however busy the board is); a card added or closed is reflected at once.
let settleTimer: ReturnType<typeof setTimeout> | null = null
function settleRoster(): void {
  settleTimer = null
  const s = useBoard.getState()
  const next = rosterSnapshot(s.nodes)
  if (!sameRoster(s.settledRoster, next)) useBoard.setState({ settledRoster: next })
}
useBoard.subscribe((s, prev) => {
  if (s.nodes === prev.nodes) return
  const next = rosterSnapshot(s.nodes)
  if (sameRoster(s.settledRoster, next)) {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
    return
  }
  if (!sameIds(s.settledRoster, next)) {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
    useBoard.setState({ settledRoster: next })
    return
  }
  if (!settleTimer) settleTimer = setTimeout(settleRoster, SETTLE_ROWS_MS)
})

// Context usage of every Claude card, read from its transcript 1.5 s after a status change (the transcript is
// written a moment after the hook); one reader for the cards, the status bar and the sidebar.
const usageKeys = new Map<string, string>()
const usageTimers = new Map<string, ReturnType<typeof setTimeout>>()
useBoard.subscribe((s, prev) => {
  if (s.nodes === prev.nodes) return
  const seen = new Set<string>()
  for (const n of s.nodes) {
    const claude = (n.data.kind === 'claude' || n.data.kind === 'conductor') && (n.data.engine ?? 'claude') === 'claude'
    if (!claude || !n.data.sessionId) continue
    seen.add(n.id)
    const key = `${n.data.sessionId}|${n.data.status ?? ''}`
    if (usageKeys.get(n.id) === key) continue
    usageKeys.set(n.id, key)
    const sessionId = n.data.sessionId
    clearTimeout(usageTimers.get(n.id))
    usageTimers.set(
      n.id,
      setTimeout(() => {
        usageTimers.delete(n.id)
        void api()
          .session.usage(sessionId)
          .then((u) => {
            if (u && useBoard.getState().nodes.some((x) => x.id === n.id)) useBoard.getState().setUsage(n.id, u)
          })
          .catch(() => undefined)
      }, 1500)
    )
  }
  for (const id of [...usageKeys.keys()]) {
    if (seen.has(id)) continue
    usageKeys.delete(id)
    clearTimeout(usageTimers.get(id))
    usageTimers.delete(id)
    if (id in s.usage) {
      const usage = { ...s.usage }
      delete usage[id]
      useBoard.setState({ usage })
    }
  }
})

// Exposed for smoke tests and quick debugging from DevTools.
;(window as unknown as { __board: typeof useBoard }).__board = useBoard
