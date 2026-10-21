import { useBoard } from '@/store/board'
import { DEFAULT_HANDOFF_TEMPLATE } from '@shared/handoff'
import type { ClaudeOptions } from '@shared/types'

export function Inspector() {
  const nodeId = useBoard((s) => s.selectedNodeId)
  const edgeId = useBoard((s) => s.selectedEdgeId)
  const node = useBoard((s) => s.nodes.find((n) => n.id === s.selectedNodeId))
  const edge = useBoard((s) => s.edges.find((e) => e.id === s.selectedEdgeId))
  const nodes = useBoard((s) => s.nodes)
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const updateEdgeData = useBoard((s) => s.updateEdgeData)
  const removeEdge = useBoard((s) => s.removeEdge)
  const restartNode = useBoard((s) => s.restartNode)
  const projectRoot = useBoard((s) => s.projectRoot)

  if (edge && edgeId) {
    const src = nodes.find((n) => n.id === edge.source)
    const dst = nodes.find((n) => n.id === edge.target)
    const d = edge.data ?? { mode: 'auto', template: DEFAULT_HANDOFF_TEMPLATE }
    return (
      <div className="panel inspector">
        <h3>Handoff</h3>
        <div className="muted small">
          {src?.data.title ?? edge.source} → {dst?.data.title ?? edge.target}
        </div>
        <label>
          Mode
          <select value={d.mode} onChange={(e) => updateEdgeData(edgeId, { mode: e.target.value as 'auto' | 'manual' })}>
            <option value="auto">auto — fire when source finishes a response</option>
            <option value="manual">manual — only when ▶ is pressed</option>
          </select>
        </label>
        <label>
          Condition (optional: substring or /regex/)
          <input className="text" value={d.condition ?? ''} placeholder="e.g. READY or /PR #\d+/" onChange={(e) => updateEdgeData(edgeId, { condition: e.target.value })} />
        </label>
        <label>
          Prompt template
          <textarea rows={8} value={d.template} onChange={(e) => updateEdgeData(edgeId, { template: e.target.value })} />
        </label>
        <div className="muted small">Placeholders: {'{{last_assistant_message}} {{source_title}} {{source_cwd}} {{target_title}}'}</div>
        {d.lastFiredAt && <div className="muted small">Last fired {new Date(d.lastFiredAt).toLocaleTimeString()}</div>}
        <div className="row">
          <button className="btn" onClick={() => void window.ouroboros.board.fireHandoff(edgeId)}>
            ▶ Send now
          </button>
          <button className="btn danger" onClick={() => removeEdge(edgeId)}>
            Delete
          </button>
        </div>
      </div>
    )
  }

  if (!node || !nodeId) {
    return (
      <div className="panel inspector">
        <h3>Inspector</h3>
        <div className="muted small">Select a card or a line. Right-click the canvas to add cards; drag from a card's right port to another card's left port to create a handoff line.</div>
      </div>
    )
  }

  const d = node.data
  const claude: ClaudeOptions = d.claude ?? {}
  const setClaude = (patch: Partial<ClaudeOptions>): void => updateNodeData(nodeId, { claude: { ...claude, ...patch } })
  const pickCwd = async (): Promise<void> => {
    const dir = await window.ouroboros.workspace.openProject()
    if (dir) updateNodeData(nodeId, { cwd: dir })
  }
  const makeWorktree = async (): Promise<void> => {
    const r = await window.ouroboros.worktree.create(projectRoot, d.title)
    if (!r.ok) {
      alert(`Worktree failed: ${r.error}`)
      return
    }
    updateNodeData(nodeId, { worktree: { path: r.path!, branch: r.branch! } })
  }
  const dropWorktree = async (): Promise<void> => {
    if (!d.worktree) return
    if (!confirm(`Remove worktree ${d.worktree.path}? Uncommitted changes there will be lost.`)) return
    const r = await window.ouroboros.worktree.remove(projectRoot, d.worktree.path)
    if (!r.ok) {
      alert(`Remove failed: ${r.error}`)
      return
    }
    updateNodeData(nodeId, { worktree: undefined })
  }

  return (
    <div className="panel inspector">
      <h3>{d.kind === 'note' ? 'Note' : d.kind === 'external' ? 'External session' : d.kind === 'conductor' ? 'Conductor' : d.kind === 'claude' ? 'Claude agent' : 'Terminal'}</h3>
      <label>
        Title
        <input className="text" value={d.title} onChange={(e) => updateNodeData(nodeId, { title: e.target.value })} />
      </label>
      {d.kind !== 'note' && (
        <label>
          Folder
          <div className="row">
            <input className="text" value={d.cwd} onChange={(e) => updateNodeData(nodeId, { cwd: e.target.value })} />
            <button className="btn" onClick={() => void pickCwd()}>…</button>
          </div>
        </label>
      )}
      {(d.kind === 'claude' || d.kind === 'conductor') && (
        <>
          <label className="row">
            <input type="checkbox" checked={Boolean(claude.continue)} onChange={(e) => setClaude({ continue: e.target.checked })} /> Continue last conversation on launch (--continue)
          </label>
          <label>
            Resume session id (--resume)
            <input className="text" value={claude.resume ?? ''} onChange={(e) => setClaude({ resume: e.target.value || undefined })} />
          </label>
          <label>
            Model
            <input className="text" placeholder="default" value={claude.model ?? ''} onChange={(e) => setClaude({ model: e.target.value || undefined })} />
          </label>
          <label>
            Permission mode
            <select value={claude.permissionMode ?? ''} onChange={(e) => setClaude({ permissionMode: (e.target.value || undefined) as ClaudeOptions['permissionMode'] })}>
              <option value="">default</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="plan">plan</option>
              <option value="auto">auto</option>
              <option value="dontAsk">dontAsk</option>
              <option value="bypassPermissions">bypassPermissions</option>
            </select>
          </label>
          <label>
            Extra system prompt
            <textarea rows={3} value={claude.appendSystemPrompt ?? ''} onChange={(e) => setClaude({ appendSystemPrompt: e.target.value || undefined })} />
          </label>
          {d.sessionId && <div className="muted small">session {d.sessionId}</div>}
        </>
      )}
      {d.kind === 'terminal' && (
        <>
          <label>
            Shell
            <input className="text" placeholder="default" value={d.shell ?? ''} onChange={(e) => updateNodeData(nodeId, { shell: e.target.value || undefined })} />
          </label>
          <label>
            Command on start
            <input className="text" value={d.initialCommand ?? ''} onChange={(e) => updateNodeData(nodeId, { initialCommand: e.target.value || undefined })} />
          </label>
        </>
      )}
      {d.kind !== 'note' && d.kind !== 'external' && (
        <div className="block">
          <div className="muted small">Git worktree</div>
          {d.worktree ? (
            <div className="row">
              <span className="small mono">{d.worktree.branch}</span>
              <button className="btn danger" onClick={() => void dropWorktree()}>
                Remove
              </button>
            </div>
          ) : (
            <button className="btn" disabled={!projectRoot} onClick={() => void makeWorktree()}>
              Create worktree for this card
            </button>
          )}
        </div>
      )}
      {d.lastAssistantMessage && (
        <div className="block">
          <div className="muted small">Last message</div>
          <div className="small clamp-6">{d.lastAssistantMessage}</div>
        </div>
      )}
      {d.kind !== 'note' && d.kind !== 'external' && (
        <div className="row">
          <button className="btn" onClick={() => void restartNode(nodeId)}>
            ↻ Apply & restart
          </button>
        </div>
      )}
    </div>
  )
}
