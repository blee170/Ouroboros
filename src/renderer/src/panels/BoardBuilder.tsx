import { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { useBoard } from '@/store/board'
import type { ClaudeProjectHistory, FolderInfo } from '@shared/protocol'
import { RESUME_CONDUCTOR_PROMPT, ROLE_ORDER, ROLE_PRESETS, buildBoard, type RoleKind } from '@shared/board-builder'
import { filterRoles, type RolesListing } from '@shared/roles'
import { Icon } from '@/lib/icons'
import { useEscape } from '@/lib/useDialog'

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
  // specialists: roles from .claude/agents and the agency catalog; a runbook ticks a whole roster
  const [library, setLibrary] = useState<RolesListing | null>(null)
  const [roleQuery, setRoleQuery] = useState('')
  const [specialists, setSpecialists] = useState<Record<string, boolean>>({})
  const [runbook, setRunbook] = useState('')
  const [fetching, setFetching] = useState<string | null>(null)
  const fetchBusy = fetching !== null && !fetching.startsWith('could')
  useEscape(onClose)

  const loadLibrary = (): void => {
    window.ouroboros.roles.list(projectRoot).then(setLibrary, () => setLibrary({ roles: [], runbooks: [] }))
  }
  useEffect(loadLibrary, [projectRoot])

  const fetchRoster = async (): Promise<void> => {
    setFetching('fetching the Agency roster…')
    const r = await window.ouroboros.roles.fetch()
    setFetching(r.ok ? null : `could not fetch: ${r.error}`)
    loadLibrary()
  }
  const currentRunbook = library?.runbooks.find((rb) => rb.slug === runbook)
  const setGroup = (ids: string[], on: boolean): void => setSpecialists((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, on])) }))
  const pickRunbook = (slug: string): void => {
    setRunbook(slug)
    const rb = library?.runbooks.find((x) => x.slug === slug)
    // a runbook replaces the picks with its roster (always-on groups ticked, optional ones off); back to "by hand" keeps them
    if (rb) setSpecialists(Object.fromEntries(rb.groups.flatMap((g) => g.agents.map((id) => [id, g.activation === 'always']))))
  }
  const selectedRoles = useMemo(() => (library?.roles ?? []).filter((r) => specialists[r.id]), [library, specialists])
  const visibleRoles = useMemo(() => filterRoles(library?.roles ?? [], roleQuery), [library, roleQuery])

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
    // the role files are read now, so a card carries its prompt even if the library changes later
    const prompts = await Promise.all(selectedRoles.map(async (r) => ({ r, prompt: await window.ouroboros.roles.read(projectRoot, r.id).catch(() => undefined) })))
    const unreadable = prompts.filter((x) => typeof x.prompt !== 'string').map((x) => x.r.id)
    if (unreadable.length) {
      setFetching(`could not read ${unreadable.length} role file${unreadable.length === 1 ? '' : 's'} (${unreadable.join(', ')}): untick or fetch the catalog again`)
      return
    }
    const specialistCards = prompts.filter((x): x is { r: (typeof selectedRoles)[number]; prompt: string } => typeof x.prompt === 'string').map(({ r, prompt }) => ({ id: r.id, name: r.name, prompt, emoji: r.emoji }))
    const built = buildBoard(
      {
        projectRoot,
        conductor: { cwd: conductorCwd, mode, sessionId: mode === 'resume' ? sessionId || undefined : undefined, initialPrompt },
        roles: chosenRoles,
        specialists: specialistCards,
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
        <h3>
          <Icon name="sparkles" /> Build board from your Claude Code work
        </h3>
        <label className="field narrow">
          <span>Root</span>
          <div className="ctl">
            <input className="text" value={root} onChange={(e) => setRoot(e.target.value)} />
            <button className="btn" title="Choose a folder" onClick={() => void pickRoot()}>
              …
            </button>
            <input className="text" style={{ maxWidth: 180, flex: 'none' }} placeholder="filter (e.g. badminton)" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </label>
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
                      <button
                        className={`btn small${isConductor ? ' primary' : ''}`}
                        onClick={() => {
                          setConductorCwd(f.path)
                          setSessionId('') // a session belongs to its folder
                        }}
                        title="Use this folder for the Conductor and the role cards">
                        {isConductor ? 'Conductor' : 'Conduct here'}
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
              <label key={r} className="role-row" title={ROLE_PRESETS[r].prompt}>
                <input type="checkbox" checked={roles[r]} onChange={(e) => setRoles({ ...roles, [r]: e.target.checked })} />
                <span>
                  {ROLE_PRESETS[r].icon} {ROLE_PRESETS[r].title}
                </span>
                <span className="desc">{ROLE_PRESETS[r].prompt.split('. ')[1]?.slice(0, 80)}…</span>
              </label>
            ))}
            <label className="role-row">
              <input type="checkbox" checked={withBrowser} onChange={(e) => setWithBrowser(e.target.checked)} />
              <span>Browser card</span>
              <span className="desc">a page the agents can drive with the browser tools</span>
            </label>
            <div className="muted small" style={{ marginTop: 10 }}>
              Specialists {library ? `· ${library.roles.length} roles${selectedRoles.length ? ` · ${selectedRoles.length} picked` : ''}` : '· loading…'}
            </div>
            {library && !library.catalog && (
              <div className="small specialists-empty">
                {library.roles.length === 0 ? 'No agent files yet. ' : 'Your own agent files are listed; '}
                <button className="btn small" disabled={fetchBusy} onClick={() => void fetchRoster()}>
                  Get the Agency roster
                </button>
                <span className="muted"> git clone of msitarzewski/agency-agents (MIT, ~5 MB) into the app's data folder; nothing is written to ~/.claude</span>
              </div>
            )}
            {fetching && <div className={`small${fetchBusy ? ' muted' : ''}`} style={fetchBusy ? undefined : { color: 'var(--warn)' }}>{fetching}</div>}
            {library && library.runbooks.length > 0 && (
              <label>
                Runbook template
                <select value={runbook} onChange={(e) => pickRunbook(e.target.value)}>
                  <option value="">— pick specialists by hand —</option>
                  {library.runbooks.map((rb) => (
                    <option key={rb.slug} value={rb.slug}>
                      {rb.title}
                      {rb.duration ? ` · ${rb.duration}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {currentRunbook && (
              <div className="runbook-groups">
                {currentRunbook.summary && <div className="muted small">{currentRunbook.summary}</div>}
                {currentRunbook.groups.map((g) => {
                  const on = g.agents.length > 0 && g.agents.every((id) => specialists[id])
                  return (
                    <label key={g.group} className="role-row" title={g.agents.join(', ')}>
                      <input type="checkbox" checked={on} disabled={g.agents.length === 0} onChange={(e) => setGroup(g.agents, e.target.checked)} />
                      <span>{g.group}</span>
                      <span className="desc">
                        {g.activation} · {g.agents.length} card{g.agents.length === 1 ? '' : 's'}
                        {g.missing.length ? ` · ${g.missing.length} not in the library` : ''}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            {library?.catalog && library.roles.every((r) => r.source !== 'agency') && (
              <div className="small specialists-empty">
                The Agency catalog folder holds no roles (an interrupted fetch?).
                <button className="btn small" disabled={fetchBusy} onClick={() => void fetchRoster()}>
                  Fetch it again
                </button>
              </div>
            )}
            {library && library.roles.length > 0 && (
              <>
                <input className="text" placeholder="search roles: frontend, security, marketing…" value={roleQuery} onChange={(e) => setRoleQuery(e.target.value)} aria-label="Search roles" />
                <ul className="role-list">
                  {visibleRoles.slice(0, 60).map((r) => (
                    <li key={r.id}>
                      <label className="role-row" title={`${r.id} · ${r.source}${r.description ? `\n${r.description}` : ''}`}>
                        <input type="checkbox" checked={Boolean(specialists[r.id])} onChange={(e) => setSpecialists({ ...specialists, [r.id]: e.target.checked })} />
                        <span>
                          {r.emoji ?? '🎭'} {r.name}
                        </span>
                        <span className="desc">
                          {r.division} · {r.description ?? r.id}
                        </span>
                      </label>
                    </li>
                  ))}
                  {visibleRoles.length > 60 && <li className="muted small">{visibleRoles.length - 60} more: narrow the search.</li>}
                  {visibleRoles.length === 0 && <li className="muted small">No role matches.</li>}
                </ul>
                {library.catalog && (
                  <div className="muted small">
                    Agency catalog {library.catalog.version ?? 'fetched'} ·{' '}
                    <button className="btn small" disabled={fetchBusy} onClick={() => void fetchRoster()}>
                      Update
                    </button>
                  </div>
                )}
              </>
            )}
            <div className="muted small" style={{ marginTop: 10 }}>
              Lines: Implementer → Tester (auto) · Tester → Reviewer (auto when the reply contains PASS) · Reviewer → Implementer (manual ▶) · every card reports to the Conductor
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
