import { useBoard } from '@/store/board'
import { DEFAULT_HANDOFF_TEMPLATE } from '@shared/handoff'
import { MCP_PRESETS, type ClaudeOptions, type McpServerSpec } from '@shared/types'
import { ChangesPanel } from './ChangesPanel'

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
      <h3>{d.kind === 'note' ? 'Note' : d.kind === 'external' ? 'External session' : d.kind === 'conductor' ? 'Conductor' : d.kind === 'claude' ? 'Claude agent' : d.kind === 'browser' ? 'Browser' : d.kind === 'command' ? 'Command card' : 'Terminal'}</h3>
      <label>
        Title
        <input className="text" value={d.title} onChange={(e) => updateNodeData(nodeId, { title: e.target.value })} />
      </label>
      {d.kind === 'browser' && (
        <>
          <label>
            Home URL
            <input className="text" value={d.url ?? ''} onChange={(e) => updateNodeData(nodeId, { url: e.target.value })} />
          </label>
          <div className="muted small">Agents drive this card with the browser_* MCP tools (Conductor has them; enable "Board & browser tools" on other Claude cards). Logins persist in the shared browser profile.</div>
        </>
      )}
      {d.kind !== 'note' && d.kind !== 'browser' && d.kind !== 'external' && <ChangesPanel nodeId={nodeId} cwd={d.worktree?.path || d.cwd} />}
      {d.kind !== 'note' && d.kind !== 'browser' && (
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
          {d.kind === 'claude' && (
            <label className="row">
              <input type="checkbox" checked={Boolean(claude.boardTools)} onChange={(e) => setClaude({ boardTools: e.target.checked })} /> Board & browser tools (ouroboros MCP: list_agents, send_prompt, browser_*)
            </label>
          )}
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
          <div className="block">
            <div className="muted small">MCP servers on this card {d.kind === 'conductor' ? '(the board server "ouroboros" is always added)' : ''}</div>
            {Object.entries(claude.mcpServers ?? {}).map(([name, spec]) => (
              <div key={name} className="row small">
                <span className="mono">{name}</span>
                <span className="muted clamp">{(spec as McpServerSpec).url ?? [(spec as McpServerSpec).command, ...((spec as McpServerSpec).args ?? [])].join(' ')}</span>
                <span className="spacer" />
                <button
                  className="icon-btn"
                  title="Remove"
                  onClick={() => {
                    const next = { ...(claude.mcpServers ?? {}) }
                    delete next[name]
                    setClaude({ mcpServers: Object.keys(next).length ? next : undefined })
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {Object.entries(MCP_PRESETS).map(([key, p]) => (
                <button key={key} className="btn small" title={p.hint} disabled={Boolean(claude.mcpServers?.[key])} onClick={() => setClaude({ mcpServers: { ...(claude.mcpServers ?? {}), [key]: p.spec } })}>
                  + {p.label}
                </button>
              ))}
              <button
                className="btn small"
                onClick={() => {
                  const raw = prompt('MCP server JSON, e.g. {"name":{"command":"npx","args":["-y","some-mcp"]}}')
                  if (!raw) return
                  try {
                    const parsed = JSON.parse(raw) as Record<string, McpServerSpec>
                    setClaude({ mcpServers: { ...(claude.mcpServers ?? {}), ...parsed } })
                  } catch (e) {
                    alert(`Invalid JSON: ${(e as Error).message}`)
                  }
                }}
              >
                + custom…
              </button>
            </div>
            <div className="muted small">Changes apply on "Apply & restart". Browser servers open their own window; the card gets the tools.</div>
          </div>
          {d.sessionId && <div className="muted small">session {d.sessionId}</div>}
        </>
      )}
      {d.kind === 'command' && (
        <>
          <label>
            Command template (runs for every prompt this card receives)
            <textarea rows={3} value={d.commandTemplate ?? ''} placeholder='aside exec {{prompt}}' onChange={(e) => updateNodeData(nodeId, { commandTemplate: e.target.value })} />
          </label>
          <div className="muted small">{'{{prompt}}'} = quoted single line, {'{{prompt_file}}'} = temp file with the full text. Output until the command exits becomes this card's reply, so outgoing lines fire when it finishes.</div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn small" onClick={() => updateNodeData(nodeId, { commandTemplate: 'aside exec {{prompt}}' })}>Aside agent</button>
            <button className="btn small" onClick={() => updateNodeData(nodeId, { commandTemplate: 'codex exec {{prompt}}' })}>Codex</button>
            <button className="btn small" onClick={() => updateNodeData(nodeId, { commandTemplate: 'claude -p {{prompt}}' })}>claude -p</button>
          </div>
          <label>
            Shell
            <input className="text" placeholder="default" value={d.shell ?? ''} onChange={(e) => updateNodeData(nodeId, { shell: e.target.value || undefined })} />
          </label>
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
      {d.kind !== 'note' && d.kind !== 'external' && d.kind !== 'browser' && (
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
      {d.kind !== 'note' && d.kind !== 'external' && d.kind !== 'browser' && (
        <div className="row">
          <button className="btn" onClick={() => void restartNode(nodeId)}>
            ↻ Apply & restart
          </button>
        </div>
      )}
    </div>
  )
}
