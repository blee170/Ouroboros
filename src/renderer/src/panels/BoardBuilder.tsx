import { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { useBoard } from '@/store/board'
import type { ClaudeProjectHistory, FolderInfo } from '@shared/protocol'
import { RESUME_CONDUCTOR_PROMPT, ROLE_ORDER, ROLE_PRESETS, buildBoard, type RoleKind } from '@shared/board-builder'

function parentOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx > 0 ? trimmed.slice(0, idx) : trimmed
}
function samePath(a: string, b: string): boolean {
  const n = (x: string): string => x.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return n(a) === n(b)
}
function ago(ms: number): string {
  const d = Date.now() - ms
  if (d < 3600e3) return `${Math.max(1, Math.round(d / 60e3))}m ago`
  if (d < 86400e3) return `${Math.round(d / 3600e3)}h ago`
  return `${Math.round(d / 86400e3)}d ago`
}

export function BoardBuilder({ onClose }: { onClose: () => void }) {
  const projectRoot = useBoard((s) => s.projectRoot)
  const existing = useBoard((s) => s.nodes.length)
  const addGenerated = useBoard((s) => s.addGenerated)
  const [root, setRoot] = useState(parentOf(projectRoot))
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [history, setHistory] = useState<ClaudeProjectHistory[]>([])
  const [filter, setFilter] = useState('')
  const [conductorCwd, setConductorCwd] = useState(projectRoot)
  const [mode, setMode] = useState<'continue' | 'resume' | 'fresh'>('continue')
  const [sessionId, setSessionId] = useState('')
  const [roles, setRoles] = useState<Record<RoleKind, boolean>>({ implementer: true, tester: true, reviewer: true, ops: true })
  const [extras, setExtras] = useState<Record<string, boolean>>({})
  const [replace, setReplace] = useState(false)
  const [initialPrompt, setInitialPrompt] = useState('')
  const [withBrowser, setWithBrowser] = useState(true)
  const settings = useBoard((s) => s.settings)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    Promise.all([window.ouroboros.folders.list(root), window.ouroboros.history.list(root)]).then(([f, h]) => {
      if (cancelled) return
      setFolders(f)
      setHistory(h)
      setBusy(false)
    })
    return () => {
      cancelled = true
    }
  }, [root])

  const sessionsFor = (cwd: string): ClaudeProjectHistory['sessions'] => history.find((h) => samePath(h.cwd, cwd))?.sessions ?? []
  const visibleFolders = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = [...folders]
    // the root itself (sessions started in e.g. ~/.claudecode live there) and the current project
    if (root && !list.some((f) => samePath(f.path, root))) list.unshift({ path: root, name: `(root) ${root.split(/[\\/]/).pop() ?? root}`, isGit: false, hasClaudeMd: false })
    if (!list.some((f) => samePath(f.path, projectRoot)) && projectRoot) list.unshift({ path: projectRoot, name: projectRoot.split(/[\\/]/).pop() ?? projectRoot, isGit: true, hasClaudeMd: false })
    return q ? list.filter((f) => f.name.toLowerCase().includes(q) || (f.packageName ?? '').toLowerCase().includes(q)) : list
  }, [folders, filter, projectRoot])
  const conductorSessions = sessionsFor(conductorCwd)

  const pickRoot = async (): Promise<void> => {
    const dir = await window.ouroboros.workspace.openProject()
    if (dir) setRoot(dir)
  }

  const create = async (): Promise<void> => {
    const chosenRoles = ROLE_ORDER.filter((r) => roles[r])
    const extraFolders = visibleFolders
      .filter((f) => extras[f.path] && !samePath(f.path, conductorCwd))
      .map((f) => {
        const latest = sessionsFor(f.path)[0]
        return { cwd: f.path, title: `${f.name} · ${latest ? 'latest' : 'new'}`, sessionId: latest?.id }
      })
    const built = buildBoard(
      {
        projectRoot,
        conductor: { cwd: conductorCwd, mode, sessionId: mode === 'resume' ? sessionId || undefined : undefined, initialPrompt },
        roles: chosenRoles,
        extraFolders,
        browser: withBrowser,
        browserUrl: settings.browserHome
      },
      () => nanoid(10)
    )
    await addGenerated(built.nodes, built.edges, replace)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>✨ Build board from your Claude Code work</h3>
        <div className="row">
          <span className="muted small">Root</span>
          <input className="text" value={root} onChange={(e) => setRoot(e.target.value)} />
          <button className="btn" onClick={() => void pickRoot()}>…</button>
          <input className="text" style={{ maxWidth: 180 }} placeholder="filter (e.g. badminton)" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="builder-grid">
          <div className="builder-col">
            <div className="muted small">Folders under root {busy ? '· loading…' : `· ${visibleFolders.length}`}</div>
            <ul className="folder-list">
              {visibleFolders.map((f) => {
                const sessions = sessionsFor(f.path)
                const isConductor = samePath(f.path, conductorCwd)
                return (
                  <li key={f.path} className={`folder-item${isConductor ? ' chosen' : ''}`}>
                    <div className="row">
                      <button className={`btn small${isConductor ? ' primary' : ''}`} onClick={() => setConductorCwd(f.path)} title="Use this folder for the Conductor and the role cards">
                        {isConductor ? '🎼 Conductor' : 'Conduct'}
                      </button>
                      <label className="row small">
                        <input type="checkbox" disabled={isConductor} checked={Boolean(extras[f.path]) && !isConductor} onChange={(e) => setExtras({ ...extras, [f.path]: e.target.checked })} /> card
                      </label>
                      <span className="title">{f.name}</span>
                      <span className="muted small">
                        {f.isGit ? 'git ' : ''}
                        {f.hasClaudeMd ? 'CLAUDE.md ' : ''}
                        {f.packageName ? `· ${f.packageName}` : ''}
                      </span>
                    </div>
                    {sessions.length > 0 && (
                      <div className="muted small session-line" title={sessions.map((s) => `${ago(s.lastAt)} · ${s.title}`).join('\n')}>
                        {sessions.length} session{sessions.length > 1 ? 's' : ''} · latest {ago(sessions[0].lastAt)}: {sessions[0].title}
                      </div>
                    )}
                    {isConductor && mode === 'resume' && sessions.length > 0 && (
                      <div className="small">
                        <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                          <option value="">— pick the session to resume —</option>
                          {sessions.map((s) => (
                            <option key={s.id} value={s.id}>
                              {ago(s.lastAt)} · {s.title}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </li>
                )
              })}
              {!busy && visibleFolders.length === 0 && <li className="muted small">No folders match.</li>}
            </ul>
          </div>
          <div className="builder-col">
            <div className="muted small">Conductor</div>
            <div className="small mono clamp">{conductorCwd}</div>
            <label>
              Session
              <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="continue">Continue the latest conversation in that folder (--continue)</option>
                <option value="resume">Resume a specific session (--resume)</option>
                <option value="fresh">Start fresh</option>
              </select>
            </label>
            {mode === 'resume' && (
              <label>
                Which session
                <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                  <option value="">— choose —</option>
                  {conductorSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {ago(s.lastAt)} · {s.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              First instruction to the Conductor (sent automatically when it is ready)
              <textarea rows={4} value={initialPrompt} placeholder="optional" onChange={(e) => setInitialPrompt(e.target.value)} />
            </label>
            {mode !== 'fresh' && (
              <button className="btn small" onClick={() => setInitialPrompt(RESUME_CONDUCTOR_PROMPT)}>
                Use "rebuild my lanes from your checkpoint" instruction
              </button>
            )}
            <div className="muted small" style={{ marginTop: 10 }}>
              Role cards (run in the Conductor's folder)
            </div>
            {ROLE_ORDER.map((r) => (
              <label key={r} className="row">
                <input type="checkbox" checked={roles[r]} onChange={(e) => setRoles({ ...roles, [r]: e.target.checked })} />
                {ROLE_PRESETS[r].icon} {ROLE_PRESETS[r].title}
                <span className="muted small">{ROLE_PRESETS[r].prompt.split('. ')[1]?.slice(0, 60)}…</span>
              </label>
            ))}
            <label className="row">
              <input type="checkbox" checked={withBrowser} onChange={(e) => setWithBrowser(e.target.checked)} /> 🌐 Browser card
            </label>
            <div className="muted small" style={{ marginTop: 10 }}>
              Lines: Implementer → Tester (auto) · Tester → Reviewer (auto when the reply contains PASS) · Reviewer → Implementer (manual ▶)
            </div>
            {existing > 0 && (
              <label className="row" style={{ marginTop: 10 }}>
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Close the {existing} existing card{existing > 1 ? 's' : ''} first
              </label>
            )}
          </div>
        </div>
        <div className="row right">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (mode === 'resume' && !sessionId)} onClick={() => void create()}>
            Create board
          </button>
        </div>
      </div>
    </div>
  )
}
