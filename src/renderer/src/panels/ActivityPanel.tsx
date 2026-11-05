import { useEffect, useMemo, useState } from 'react'
import type { CardActivityView, ChangesSummary } from '@shared/protocol'
import { elapsedText, shownPath, type EditTurn, type SubagentRun, type TouchedFile } from '@shared/activity'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const SHOWN_FILES = 60
const SHOWN_SUBAGENTS = 15

function openFile(path: string, cwd: string): void {
  void window.ouroboros.shell.openPath(path, cwd).then((r) => {
    if (!r.ok) alert(r.error ?? 'Could not open the file')
  })
}

/**
 * What a Claude card did, from its hooks: a replay of the edits of its last turns, its subagents, and the files it
 * read and wrote. Main keeps the record (in memory, while the app runs); the board's summary says when it changed.
 */
export function ActivityPanel({ nodeId, cwd }: { nodeId: string; cwd: string }) {
  const rev = useBoard((s) => s.activity[nodeId]?.rev)
  const [view, setView] = useState<CardActivityView | null>(null)
  useEffect(() => {
    let alive = true
    // a busy turn changes the record several times a second: read it once things settle for a moment
    const t = setTimeout(
      () => {
        void window.ouroboros.activity
          .get(nodeId)
          .then((v) => {
            if (alive) setView(v)
          })
          .catch(() => undefined)
      },
      rev === undefined ? 0 : 300
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [nodeId, rev])
  if (!view) return null
  return (
    <>
      {view.turns.length > 0 && <EditReplay turns={view.turns} cwd={cwd} />}
      {view.subagents.length > 0 && <Subagents runs={view.subagents} />}
      {view.files.length > 0 && <TouchedFiles files={view.files} cwd={cwd} rev={view.rev} />}
    </>
  )
}

/** Step through the file edits of a turn, one diff at a time (the last turn that edited files, or an earlier one). */
function EditReplay({ turns, cwd }: { turns: EditTurn[]; cwd: string }) {
  const [open, setOpen] = useState(true)
  // null = the latest turn, the latest edit: both follow the card while it works
  const [picked, setPicked] = useState<string | null>(null)
  const [step, setStep] = useState<number | null>(null)
  const turn = turns.find((t) => t.id === picked) ?? turns[turns.length - 1]
  const total = turn.edits.length
  const at = step === null ? total - 1 : Math.min(step, total - 1)
  const edit = turn.edits[at]
  const added = turn.edits.reduce((n, e) => n + e.added, 0)
  const removed = turn.edits.reduce((n, e) => n + e.removed, 0)
  const go = (to: number): void => {
    const i = Math.max(0, Math.min(to, total - 1))
    setStep(i === total - 1 ? null : i)
  }
  const isLast = turn === turns[turns.length - 1]
  return (
    <div className="changes replay">
      <div className="row between">
        <button className="link" onClick={() => setOpen(!open)}>
          <Icon name="chevron" size={12} style={{ transform: open ? 'none' : 'rotate(-90deg)' }} /> {isLast ? 'Last turn' : `Turn at ${clock(turn.startedAt)}`} · {total + (turn.dropped ?? 0)} edit{total + (turn.dropped ?? 0) === 1 ? '' : 's'} · <span className="add">+{added}</span> <span className="del">−{removed}</span>
        </button>
        {turns.length > 1 && (
          <select
            className="replay-turn"
            aria-label="Turn to replay"
            value={isLast ? '' : turn.id}
            onChange={(e) => {
              setPicked(e.target.value || null)
              setStep(null)
            }}
          >
            {[...turns].reverse().map((t, i) => (
              <option key={t.id} value={i === 0 ? '' : t.id}>
                {i === 0 ? 'last turn' : clock(t.startedAt)} · {t.edits.length}
              </option>
            ))}
          </select>
        )}
      </div>
      {open && edit && (
        <div
          className="replay-body"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') go(at - 1)
            else if (e.key === 'ArrowRight') go(at + 1)
            else return
            e.preventDefault()
          }}
        >
          <div className="replay-steps" role="tablist" aria-label="Edits of this turn">
            {turn.edits.map((e, i) => (
              <button key={i} role="tab" aria-selected={i === at} className={`replay-step${i === at ? ' active' : ''}${e.kind === 'create' ? ' new' : ''}`} title={shownPath(e.path, cwd)} onClick={() => go(i)}>
                {i + 1}
              </button>
            ))}
          </div>
          <div className="row between replay-head">
            <button className="link replay-file" title={`${edit.path}\nClick to open`} onClick={() => openFile(edit.path, cwd)}>
              <bdi>{shownPath(edit.path, cwd)}</bdi>
            </button>
            <span className="small muted replay-meta">
              {edit.kind === 'create' ? 'new file' : edit.tool} · <span className="add">+{edit.added}</span> <span className="del">−{edit.removed}</span>
              {edit.agentId ? ' · subagent' : ''} · {clock(edit.at)}
            </span>
          </div>
          <pre className="diff">
            {edit.lines.map((l, i) => (
              <span key={i} className={l.op === '+' ? 'dl-add' : l.op === '-' ? 'dl-del' : l.op === '@' ? 'dl-hunk' : ''}>
                {l.op === '@' ? l.text : `${l.op}${l.text}`}
                {'\n'}
              </span>
            ))}
            {edit.truncated && <span className="dl-hunk">… the rest of this diff is not kept (see Changes below for the file as it is now){'\n'}</span>}
          </pre>
          <div className="row between">
            <span className="small muted">
              step {at + 1} of {total}
              {turn.dropped ? ` (${turn.dropped} more not kept)` : ''}
            </span>
            <span className="row replay-nav">
              <button className="btn small" disabled={at === 0} onClick={() => go(at - 1)} title="Previous edit (←)">
                ◀ Prev
              </button>
              <button className="btn small" disabled={at >= total - 1} onClick={() => go(at + 1)} title="Next edit (→)">
                Next ▶
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/** The card's subagents: the running ones with a clock, then the finished ones with how long they took and their first words. */
function Subagents({ runs }: { runs: SubagentRun[] }) {
  const [open, setOpen] = useState(true)
  const running = runs.filter((r) => r.endedAt === undefined)
  const finished = runs.filter((r) => r.endedAt !== undefined).reverse()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (running.length === 0) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [running.length])
  const shown = [...running, ...finished].slice(0, SHOWN_SUBAGENTS)
  return (
    <div className="changes subagents">
      <button className="link" onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={12} style={{ transform: open ? 'none' : 'rotate(-90deg)' }} /> Subagents · {running.length > 0 ? `${running.length} running` : 'none running'}
        {finished.length > 0 ? ` · ${finished.length} finished` : ''}
      </button>
      {open && (
        <ul className="sub-list">
          {shown.map((r) => (
            <li key={r.id} className={r.endedAt === undefined ? 'running' : ''} title={r.result}>
              <span className="sub-dot" aria-hidden="true" />
              <span className="sub-type">{r.type}</span>
              <span className="sub-desc">{r.description ?? ''}</span>
              <span className="sub-time">{elapsedText((r.endedAt ?? Math.max(now, r.startedAt)) - r.startedAt)}</span>
              {r.result && <span className="sub-result">{r.result}</span>}
            </li>
          ))}
          {runs.length > shown.length && <li className="muted small">… {runs.length - shown.length} earlier</li>}
        </ul>
      )}
    </div>
  )
}

/** Git's letter for a touched file: the changed file whose path ends the touched one (git paths are relative to the repo). */
function gitStatusOf(path: string, changes: ChangesSummary | null): string | undefined {
  if (!changes?.repo) return undefined
  const p = path.replace(/\\/g, '/').toLowerCase()
  return changes.files.find((f) => p.endsWith(`/${f.path.toLowerCase()}`))?.status
}

/** The files the card read and wrote since the app started, most recent first, with git's status where it has one. */
function TouchedFiles({ files, cwd, rev }: { files: TouchedFile[]; cwd: string; rev: number }) {
  const [open, setOpen] = useState(false)
  const [writesOnly, setWritesOnly] = useState(false)
  const [changes, setChanges] = useState<ChangesSummary | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.ouroboros.changes
      .summary(cwd)
      .then((c) => {
        if (alive) setChanges(c)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open, cwd, rev])
  const written = useMemo(() => files.filter((f) => f.writes > 0), [files])
  const list = writesOnly ? written : files
  return (
    <div className="changes touched">
      <div className="row between">
        <button className="link" onClick={() => setOpen(!open)}>
          <Icon name="chevron" size={12} style={{ transform: open ? 'none' : 'rotate(-90deg)' }} /> Files touched · {files.length}
          {written.length > 0 ? ` · ${written.length} written` : ''}
        </button>
        {open && written.length > 0 && written.length < files.length && (
          <label className="small muted touched-filter">
            <input type="checkbox" checked={writesOnly} onChange={(e) => setWritesOnly(e.target.checked)} /> written only
          </label>
        )}
      </div>
      {open && (
        <ul className="change-list">
          {list.slice(0, SHOWN_FILES).map((f) => {
            const st = gitStatusOf(f.path, changes)
            return (
              <li key={f.path}>
                <button className="change-file touched-file" title={`${f.path}\nread ${f.reads}×, written ${f.writes}× · last ${clock(f.lastAt)}\nClick to open`} onClick={() => openFile(f.path, cwd)}>
                  <span className={`touch-kind ${f.writes > 0 ? 'w' : 'r'}`}>{f.writes > 0 ? 'W' : 'R'}</span>
                  <span className="path">
                    <bdi>{shownPath(f.path, cwd)}</bdi>
                  </span>
                  <span className={`st st-${st ?? ''}`}>{st ?? ''}</span>
                  <span className="muted">{clock(f.lastAt)}</span>
                </button>
              </li>
            )
          })}
          {list.length > SHOWN_FILES && <li className="muted small">… {list.length - SHOWN_FILES} more</li>}
        </ul>
      )}
    </div>
  )
}
