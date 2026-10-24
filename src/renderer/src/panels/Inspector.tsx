import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useBoard } from '@/store/board'
import { DEFAULT_HANDOFF_TEMPLATE } from '@shared/handoff'
import { MCP_PRESETS, normalizeEngine, type ClaudeOptions, type McpServerSpec } from '@shared/types'
import { Icon } from '@/lib/icons'
import type { RoleEntry } from '@shared/roles'
import { ChangesPanel } from './ChangesPanel'
import { CheckpointsPanel } from './CheckpointsPanel'
import { ReplyView } from './ReplyView'

/** A titled group of fields; the same grammar as the Settings dialog. */
function Section({ title, first, children, hint }: { title: string; first?: boolean; hint?: string; children: ReactNode }) {
  return (
    <section className={`isec${first ? ' first' : ''}`}>
      <h4>{title}</h4>
      {hint && <div className="hint">{hint}</div>}
      {children}
    </section>
  )
}

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
  const retireMinutes = useBoard((s) => s.settings.retireMinutes ?? 5)
  // specialist roles for the Launch section; read once per project
  const [roles, setRoles] = useState<RoleEntry[] | null>(null)
  const isAgentNode = node?.data.kind === 'claude' || node?.data.kind === 'conductor'
  useEffect(() => {
    if (!isAgentNode) return
    // per selection: the catalog may have been fetched in Build board since the last look
    window.ouroboros.roles.list(projectRoot).then((l) => setRoles(l.roles), () => setRoles([]))
  }, [isAgentNode, nodeId, projectRoot])
  // a new selection starts at the top of the panel, whatever was scrolled before
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    root.current?.parentElement?.scrollTo({ top: 0 })
  }, [nodeId, edgeId])

  if (edge && edgeId) {
    const src = nodes.find((n) => n.id === edge.source)
    const dst = nodes.find((n) => n.id === edge.target)
    const d = edge.data ?? { mode: 'auto', template: DEFAULT_HANDOFF_TEMPLATE }
    return (
      <div className="panel inspector" ref={root}>
        <h3>Line</h3>
        <div className="muted small">
          {src?.data.title ?? edge.source} → {dst?.data.title ?? edge.target}
        </div>
        <label>
          Mode
          <select value={d.mode} onChange={(e) => updateEdgeData(edgeId, { mode: e.target.value as 'auto' | 'manual' })}>
            <option value="auto">auto — fire when the source finishes a reply</option>
            <option value="manual">manual — only when Send now is pressed</option>
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
          <button
            className="btn"
            onClick={() =>
              void window.ouroboros.board.fireHandoff(edgeId).then((r) => {
                if (!r.ok) alert(r.error)
              })
            }
          >
            <Icon name="play" size={12} /> Send now
          </button>
          <button className="btn danger" onClick={() => removeEdge(edgeId)}>
            Delete line
          </button>
        </div>
      </div>
    )
  }

  if (!node || !nodeId) {
    return (
      <div className="panel inspector" ref={root}>
        <div className="muted small">Select a card or a line. Right-click the canvas to add cards; drag from a card's right port to another card's left port to draw a line.</div>
      </div>
    )
  }

  const d = node.data
  const parentTitle = d.parentId ? nodes.find((n) => n.id === d.parentId)?.data.title : undefined
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
  const isAgent = d.kind === 'claude' || d.kind === 'conductor'
  const isProcess = d.kind !== 'note' && d.kind !== 'browser' && d.kind !== 'external'
  const heading = d.kind === 'note' ? 'Note' : d.kind === 'external' ? 'External session' : d.kind === 'conductor' ? 'Conductor' : d.kind === 'claude' ? (d.engine === 'codex' ? 'Codex agent' : d.engine === 'gemini' ? 'Gemini agent' : 'Claude agent') : d.kind === 'browser' ? 'Browser' : d.kind === 'command' ? 'Command card' : 'Terminal'

  return (
    <div className="panel inspector" ref={root}>
      <h3>{heading}</h3>
      <Section title="Card" first>
        <label className="field">
          <span>Title</span>
          <div className="ctl">
            <input className="text" value={d.title} onChange={(e) => updateNodeData(nodeId, { title: e.target.value })} />
          </div>
        </label>
        {d.kind === 'browser' && (
          <>
            <label className="field">
              <span>Home URL</span>
              <div className="ctl">
                <input className="text" value={d.url ?? ''} onChange={(e) => updateNodeData(nodeId, { url: e.target.value })} />
              </div>
            </label>
            <div className="hint">Agents drive this card with the browser_* MCP tools (Conductor has them; enable "Board & browser tools" on other Claude cards). Logins persist in the shared browser profile.</div>
          </>
        )}
        {(isProcess || d.kind === 'external') && (
          <label className="field">
            <span>Folder</span>
            <div className="ctl">
              <input className="text" value={d.cwd} onChange={(e) => updateNodeData(nodeId, { cwd: e.target.value })} />
              <button className="btn" title="Choose a folder" onClick={() => void pickCwd()}>
                …
              </button>
            </div>
          </label>
        )}
        {isProcess && d.kind !== 'conductor' && (
          <label className="check" title={d.parentId ? (retireMinutes > 0 ? `Dispatched cards are closed on their own ${retireMinutes} min after their report reached the card that made them; pin to keep it` : 'Dispatched cards are not closed on their own (retire time is 0); pinning keeps it out of Tidy') : 'Cards you made are never closed automatically; pinning also keeps it out of Tidy'}>
            <input type="checkbox" checked={Boolean(d.keep)} onChange={(e) => updateNodeData(nodeId, { keep: e.target.checked || undefined })} />
            <Icon name="pin" size={14} /> Keep
            <span className="muted small">{d.parentId ? `dispatched by ${parentTitle ?? 'a card that is gone'}` : 'made by you'}</span>
          </label>
        )}
      </Section>

      {isProcess && (
        <Section title="Work">
          <ChangesPanel key={nodeId} nodeId={nodeId} cwd={d.worktree?.path || d.cwd} />
          <CheckpointsPanel key={`cp-${nodeId}`} cwd={d.worktree?.path || d.cwd} />
          <div className="row">
            <span className="muted small">Git worktree</span>
            {d.worktree ? (
              <>
                <span className="small mono">{d.worktree.branch}</span>
                <span className="spacer" />
                <button className="btn small danger" onClick={() => void dropWorktree()}>
                  Remove
                </button>
              </>
            ) : (
              <>
                <span className="spacer" />
                <button className="btn small" disabled={!projectRoot} onClick={() => void makeWorktree()}>
                  Create worktree for this card
                </button>
              </>
            )}
          </div>
        </Section>
      )}

      {isAgent && (
        <Section title="Launch" hint="Applies on Apply & restart; the conversation continues.">
          <label className="field">
            <span>Role</span>
            <div className="ctl">
              <select
                value={d.kind}
                onChange={(e) => {
                  const kind = e.target.value as 'claude' | 'conductor'
                  if (kind === d.kind) return
                  // keep the session: a relaunch resumes it instead of starting fresh
                  updateNodeData(nodeId, { kind, claude: { ...claude, resume: d.sessionId ?? claude.resume, continue: d.sessionId ? undefined : claude.continue } })
                  void restartNode(nodeId)
                }}
              >
                <option value="claude">Agent card</option>
                <option value="conductor">Conductor (board tools + conductor playbook)</option>
              </select>
            </div>
          </label>
          <label className="field">
            <span>Engine</span>
            <div className="ctl">
              <select value={d.engine ?? 'claude'} onChange={(e) => updateNodeData(nodeId, { engine: normalizeEngine(e.target.value) })}>
                <option value="claude">Claude Code</option>
                <option value="codex">OpenAI Codex CLI</option>
                <option value="gemini">Gemini CLI</option>
              </select>
            </div>
            {d.engine === 'codex' && <div className="hint">Codex: turn-complete notify → status; board tools and role prompt via -c overrides; resume uses the thread id. Needs Node.js on PATH.</div>}
            {d.engine === 'gemini' && <div className="hint">Gemini: hooks + MCP from a per-card settings file (your ~/.gemini settings stay); the role prompt is typed as the first message.</div>}
          </label>
          <label className="check">
            <input type="checkbox" checked={Boolean(claude.continue)} onChange={(e) => setClaude({ continue: e.target.checked })} /> Continue the last conversation on launch (--continue)
          </label>
          {d.kind === 'claude' && (
            <label className="check">
              <input type="checkbox" checked={Boolean(claude.boardTools)} onChange={(e) => setClaude({ boardTools: e.target.checked })} /> Board & browser tools (ouroboros MCP: list_agents, send_prompt, browser_*)
            </label>
          )}
          <label className="field">
            <span>Resume session</span>
            <div className="ctl">
              <input className="text mono" placeholder="session id (--resume)" value={claude.resume ?? ''} onChange={(e) => setClaude({ resume: e.target.value || undefined })} />
            </div>
          </label>
          <label className="field">
            <span>Model</span>
            <div className="ctl">
              <input className="text" placeholder="default" value={claude.model ?? ''} onChange={(e) => setClaude({ model: e.target.value || undefined })} />
            </div>
          </label>
          <label className="field">
            <span>Permissions</span>
            <div className="ctl">
              <select value={claude.permissionMode ?? ''} onChange={(e) => setClaude({ permissionMode: (e.target.value || undefined) as ClaudeOptions['permissionMode'] })}>
                <option value="">default</option>
                <option value="acceptEdits">acceptEdits</option>
                <option value="plan">plan</option>
                <option value="auto">auto</option>
                <option value="dontAsk">dontAsk</option>
                <option value="bypassPermissions">bypassPermissions</option>
              </select>
            </div>
          </label>
          <label className="field">
            <span>Specialist</span>
            <div className="ctl">
              <select
                value={typeof d.role === 'string' ? d.role : ''}
                onChange={(e) => {
                  const id = e.target.value
                  if (!id) {
                    // only the label goes: the prompt text stays as it is (it may be hand-edited)
                    updateNodeData(nodeId, { role: undefined })
                    return
                  }
                  void window.ouroboros.roles.read(projectRoot, id).then((prompt) => {
                    if (prompt) updateNodeData(nodeId, { role: id, claude: { ...claude, appendSystemPrompt: prompt } })
                  })
                }}
              >
                <option value="">{roles && roles.length === 0 ? 'none (no role files: Build board → Get the Agency roster)' : 'none'}</option>
                {typeof d.role === 'string' && roles && !roles.some((r) => r.id === d.role) && <option value={d.role}>{d.role} (not in the library)</option>}
                {[...new Set((roles ?? []).map((r) => r.division))].map((division) => (
                  <optgroup key={division} label={division === 'project' || division === 'user' ? `${division} · .claude/agents` : `agency · ${division}`}>
                    {(roles ?? [])
                      .filter((r) => r.division === division)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="hint">A role file (.claude/agents or the agency catalog) replaces the extra system prompt below; editing the text afterwards keeps it and drops the label. Picking none keeps the text.</div>
          </label>
          <label>
            Extra system prompt
            <textarea rows={3} value={claude.appendSystemPrompt ?? ''} onChange={(e) => updateNodeData(nodeId, { claude: { ...claude, appendSystemPrompt: e.target.value || undefined }, ...(typeof d.role === 'string' ? { role: undefined } : {}) })} />
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
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    const next = { ...(claude.mcpServers ?? {}) }
                    delete next[name]
                    setClaude({ mcpServers: Object.keys(next).length ? next : undefined })
                  }}
                >
                  <Icon name="close" size={12} />
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
            <div className="hint">Browser servers open their own window; the card gets the tools.</div>
          </div>
          {d.sessionId && (
            <div className="muted small mono" title="Claude Code session id">
              session {d.sessionId}
            </div>
          )}
          <div className="row">
            <button className="btn" onClick={() => void restartNode(nodeId)}>
              <Icon name="refresh" /> Apply & restart
            </button>
          </div>
        </Section>
      )}

      {d.kind === 'command' && (
        <Section title="Launch" hint="Applies on Apply & restart.">
          <label>
            Command template (runs for every prompt this card receives)
            <textarea rows={3} value={d.commandTemplate ?? ''} placeholder="aside exec {{prompt}}" onChange={(e) => updateNodeData(nodeId, { commandTemplate: e.target.value })} />
          </label>
          <div className="hint">{'{{prompt}}'} = quoted single line, {'{{prompt_file}}'} = temp file with the full text. Output until the command exits becomes this card's reply, so outgoing lines fire when it finishes.</div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn small" onClick={() => updateNodeData(nodeId, { commandTemplate: 'aside exec {{prompt}}' })}>
              Aside agent
            </button>
            <button className="btn small" onClick={() => updateNodeData(nodeId, { commandTemplate: 'codex exec {{prompt}}' })}>
              Codex
            </button>
            <button className="btn small" onClick={() => updateNodeData(nodeId, { commandTemplate: 'claude -p {{prompt}}' })}>
              claude -p
            </button>
          </div>
          <label className="field">
            <span>Shell</span>
            <div className="ctl">
              <input className="text" placeholder="default" value={d.shell ?? ''} onChange={(e) => updateNodeData(nodeId, { shell: e.target.value || undefined })} />
            </div>
          </label>
          <div className="row">
            <button className="btn" onClick={() => void restartNode(nodeId)}>
              <Icon name="refresh" /> Apply & restart
            </button>
          </div>
        </Section>
      )}

      {d.kind === 'terminal' && (
        <Section title="Launch" hint="Applies on Apply & restart.">
          <label className="field">
            <span>Shell</span>
            <div className="ctl">
              <input className="text" placeholder="default" value={d.shell ?? ''} onChange={(e) => updateNodeData(nodeId, { shell: e.target.value || undefined })} />
            </div>
          </label>
          <label className="field">
            <span>On start</span>
            <div className="ctl">
              <input className="text mono" placeholder="command to run first" value={d.initialCommand ?? ''} onChange={(e) => updateNodeData(nodeId, { initialCommand: e.target.value || undefined })} />
            </div>
          </label>
          <div className="row">
            <button className="btn" onClick={() => void restartNode(nodeId)}>
              <Icon name="refresh" /> Apply & restart
            </button>
          </div>
        </Section>
      )}

      {d.lastAssistantMessage && (
        <Section title="Last reply">
          <ReplyView text={d.lastAssistantMessage} cwd={d.cwd} title={d.title} />
        </Section>
      )}
    </div>
  )
}
