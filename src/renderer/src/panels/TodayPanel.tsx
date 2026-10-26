import { useEffect, useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useBoard } from '@/store/board'
import { agoText } from '@shared/usage'
import { needsYou, todayView, type Need, type NeedKind, type TodayCard } from '@shared/today'

const KIND_LABEL: Record<NeedKind, string> = {
  approval: 'approve',
  handoff: 'grok bot',
  permission: 'prompt',
  held: 'held',
  decision: 'decide',
  failed: 'failed',
  blocked: 'blocked'
}
type BoardState = ReturnType<typeof useBoard.getState>

/** The board's agent cards in the shape the Today model reads. */
export function todayCards(s: Pick<BoardState, 'nodes' | 'attention' | 'workingSince'>): TodayCard[] {
  return s.nodes
    // an outside session cannot be answered from the board, so it is not "waiting on you" here
    .filter((n) => n.data.kind !== 'note' && n.data.kind !== 'browser' && n.data.kind !== 'external')
    .map((n) => ({ id: n.id, title: n.data.title, kind: n.data.kind, status: n.data.status, statusDetail: n.data.statusDetail, lastAssistantMessage: n.data.lastAssistantMessage, unreadAt: s.attention.unread[n.id], workingSince: s.workingSince[n.id] }))
}

/** How many things wait on the owner: the Today tab's badge. */
export const needsCount = (s: BoardState): number => needsYou({ cards: todayCards(s), tasks: s.tasks, approvals: s.approvals, held: s.held, handoffs: s.grokHandoffs }).length

const hhmm = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * The Today tab of the right panel: everything waiting on the owner in one ranked list (approvals, cards on a
 * prompt, held cards, decisions a reply or a task asked for, failures, blocked tasks), then what happened today:
 * the autonomous run, reports not looked at yet, cards working now and tasks finished since midnight.
 */
export function TodayPanel() {
  const nodes = useBoard((s) => s.nodes)
  const tasks = useBoard((s) => s.tasks)
  const approvals = useBoard((s) => s.approvals)
  const handoffs = useBoard((s) => s.grokHandoffs)
  const held = useBoard((s) => s.held)
  const attention = useBoard((s) => s.attention)
  const workingSince = useBoard((s) => s.workingSince)
  const autonomy = useBoard((s) => s.autonomy)
  const select = useBoard((s) => s.select)
  const showRpanel = useBoard((s) => s.showRpanel)
  const rf = useReactFlow()
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState('')
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const cards = useMemo(() => todayCards({ nodes, attention, workingSince }), [nodes, attention, workingSince])
  const needs = useMemo(() => needsYou({ cards, tasks, approvals, held, handoffs }), [cards, tasks, approvals, held, handoffs])
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())
  const [reviewing, setReviewing] = useState<string | null>(null)
  const routineTail = useBoard((s) => (s.settings.grokBotUrl ?? '').split('/').pop()?.slice(-8) || '(not set)')
  const today = useMemo(() => todayView({ cards, tasks, now }), [cards, tasks, now])

  const jump = (id: string | undefined): void => {
    if (!id || !nodes.some((n) => n.id === id)) return
    void rf.fitView({ nodes: [{ id }], duration: 300, padding: 0.3 })
    select(id, null)
  }
  const open = (n: Need): void => {
    if (n.cardId) jump(n.cardId)
    else if (n.taskId) showRpanel('tasks')
  }
  const resolve = async (id: string, approve: boolean): Promise<void> => {
    const r = await window.ouroboros.gate.resolve(id, approve)
    setError(r.ok ? (r.warning ?? '') : (r.error ?? 'failed'))
  }
  const decideHandoff = async (id: string, send: boolean): Promise<void> => {
    setSending((prev) => new Set(prev).add(id))
    try {
      const r = await window.ouroboros.grokBot.resolve(id, send)
      setError(r.ok ? (r.warning ?? '') : (r.error ?? 'failed'))
    } finally {
      setSending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }
  const openReport = async (path: string): Promise<void> => {
    const r = await window.ouroboros.shell.openPath(path)
    setError(r.ok ? '' : `${r.path}: ${r.error ?? 'could not open'}`)
  }
  const midnight = new Date(now).setHours(0, 0, 0, 0)

  return (
    <div className="panel today">
      <section className="task-group">
        <h4>Needs you{needs.length > 0 && ` · ${needs.length}`}</h4>
        {needs.length === 0 && <div className="muted small">Nothing is waiting on you.</div>}
        <ul className="task-list">
          {needs.map((n) => (
            <li key={n.key} className="task-row">
              <div className="task-line">
                <button className="task-toggle" onClick={() => open(n)} title={n.cardId ? 'Show the card' : n.taskId ? 'Open the Tasks tab' : undefined} disabled={!n.cardId && !n.taskId}>
                  <span className={`today-kind k-${n.kind}`}>{KIND_LABEL[n.kind]}</span>
                  <span className="task-title">
                    <b>{n.title}</b> <span className="muted">{n.text}</span>
                  </span>
                </button>
                {n.at !== undefined && <span className="muted small today-ago">{agoText(n.at, now)}</span>}
              </div>
              {n.handoffId && (() => {
                const h = handoffs.find((x) => x.id === n.handoffId)
                if (!h) return null
                const open = reviewing === h.id
                const busy = sending.has(h.id)
                return (
                  <>
                    {open && (
                      <div className="today-handoff">
                        <div className="muted small">
                          Everything below leaves this machine, to Grok Bot routine <code>…{routineTail}</code>:
                        </div>
                        <div className="small">
                          <b>Task</b>
                        </div>
                        <pre>{h.task}</pre>
                        {h.context && (
                          <>
                            <div className="small">
                              <b>Context</b> <span className="muted">({h.context.length} characters)</span>
                            </div>
                            <pre>{h.context}</pre>
                          </>
                        )}
                      </div>
                    )}
                    <div className="row today-actions">
                      <button className="btn small" onClick={() => setReviewing(open ? null : h.id)} aria-expanded={open}>
                        {open ? 'Hide' : `Review${h.context ? ' task and context' : ''}`}
                      </button>
                      <span className="spacer" />
                      <button className="btn small" disabled={busy} onClick={() => void decideHandoff(h.id, false)}>
                        Discard
                      </button>
                      <button className="btn small primary" disabled={busy || !open} title={open ? 'Send exactly what is shown above' : 'Review what would be sent first'} onClick={() => void decideHandoff(h.id, true)}>
                        {busy ? 'Sending…' : 'Send to Grok Bot'}
                      </button>
                    </div>
                  </>
                )
              })()}
              {n.approvalId && (
                <div className="row today-actions">
                  <span className="spacer" />
                  <button className="btn small" onClick={() => void resolve(n.approvalId!, false)}>
                    Deny
                  </button>
                  <button className="btn small primary" onClick={() => void resolve(n.approvalId!, true)} title="Allow this exact command once, for this card, within 30 minutes">
                    Approve once
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {error && <div className="task-error">{error}</div>}
      </section>

      {(autonomy.on || (autonomy.ended && autonomy.ended.at >= midnight)) && (
        <section className="task-group">
          <h4>Autonomous run</h4>
          {autonomy.on ? (
            <div className="small">
              Running since {autonomy.startedAt ? hhmm(autonomy.startedAt) : '?'}
              {autonomy.until ? ` · until ${hhmm(autonomy.until)}` : ''} · {autonomy.dispatches}
              {autonomy.maxDispatches ? `/${autonomy.maxDispatches}` : ''} dispatches
              {autonomy.parked.length > 0 && ` · ${autonomy.parked.length} parked`}
            </div>
          ) : (
            autonomy.ended && (
              <div className="small row">
                <span>
                  Ended {hhmm(autonomy.ended.at)}: {autonomy.ended.reason}
                </span>
                <span className="spacer" />
                {autonomy.ended.reportPath && (
                  <button className="btn small" onClick={() => void openReport(autonomy.ended!.reportPath)}>
                    Open report
                  </button>
                )}
              </div>
            )
          )}
        </section>
      )}

      {today.reports.length > 0 && (
        <section className="task-group">
          <h4>Reports</h4>
          <ul className="task-list">
            {today.reports.map((r) => (
              <li key={r.cardId} className="task-row">
                <div className="task-line">
                  <button className="task-toggle" onClick={() => jump(r.cardId)} title="Show the card">
                    <span className="task-title">
                      <b>{r.title}</b> <span className="muted">{r.line}</span>
                    </span>
                  </button>
                  <span className="muted small today-ago">{agoText(r.at, now)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="task-group">
        <h4>Working now{today.working.length > 0 && ` · ${today.working.length}`}</h4>
        {today.working.length === 0 && <div className="muted small">No card is working.</div>}
        <ul className="task-list">
          {today.working.map((c) => (
            <li key={c.id} className="task-row">
              <div className="task-line">
                <button className="task-toggle" onClick={() => jump(c.id)} title="Show the card">
                  <span className="task-title">
                    <b>{c.title}</b> <span className="muted">{c.statusDetail}</span>
                  </span>
                </button>
                {c.workingSince !== undefined && <span className="muted small today-ago">since {hhmm(c.workingSince)}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="task-group">
        <h4>Done today{today.done.length > 0 && ` · ${today.done.length}`}</h4>
        {today.done.length === 0 && <div className="muted small">No task finished since midnight.</div>}
        <ul className="task-list">
          {today.done.map((t) => (
            <li key={t.id} className="task-row">
              <div className="task-line">
                <button className="task-toggle" onClick={() => showRpanel('tasks')} title={t.result || 'Open the Tasks tab'}>
                  <span className="task-id">{t.id}</span>
                  <span className="task-title">{t.title}</span>
                </button>
                <span className="muted small today-ago">{hhmm(t.updatedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
