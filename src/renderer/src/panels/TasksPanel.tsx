import { useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { TASK_STATES, type Task, type TaskState } from '@shared/ledger'

const GROUPS: Array<{ state: TaskState; label: string; hint: string }> = [
  { state: 'blocked', label: 'Needs you', hint: 'Blocked tasks: a decision, a permission or something a card could not do' },
  { state: 'doing', label: 'Doing', hint: 'Claimed by a card' },
  { state: 'todo', label: 'To do', hint: 'Open, nobody on it' },
  { state: 'done', label: 'Done', hint: 'Finished (dropped ones at the end)' }
]
const STATE_LABEL: Record<TaskState, string> = { todo: 'to do', doing: 'doing', blocked: 'blocked', done: 'done', dropped: 'dropped' }

/**
 * The Tasks tab of the right panel: the project's task ledger, the same list the Conductor keeps through the
 * task_* tools. The owner adds tasks, changes their state, writes a result or a reason, and jumps to the owner card.
 */
export function TasksPanel() {
  const tasks = useBoard((s) => s.tasks)
  const nodes = useBoard((s) => s.nodes)
  const select = useBoard((s) => s.select)
  const rf = useReactFlow()
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [doneOpen, setDoneOpen] = useState(false)
  const [error, setError] = useState('')
  const titles = useMemo(() => new Map(nodes.map((n) => [n.id, n.data.title])), [nodes])
  const byState = useMemo(() => {
    const m: Record<TaskState, Task[]> = { todo: [], doing: [], blocked: [], done: [], dropped: [] }
    for (const t of tasks) m[t.state].push(t)
    return m
  }, [tasks])

  const add = async (): Promise<void> => {
    const t = title.trim()
    if (!t) return
    const r = await window.ouroboros.tasks.create({ title: t })
    if (r.ok) {
      setTitle('')
      setError('')
    } else setError(r.error)
  }
  const update = async (id: string, patch: Parameters<typeof window.ouroboros.tasks.update>[1]): Promise<boolean> => {
    const r = await window.ouroboros.tasks.update(id, patch)
    setError(r.ok ? '' : `${id}: ${r.error}`)
    return r.ok
  }
  const jump = (id: string): void => {
    if (!nodes.some((n) => n.id === id)) return
    void rf.fitView({ nodes: [{ id }], duration: 300, padding: 0.3 })
    select(id, null)
  }

  const row = (t: Task): React.ReactElement => {
    const expanded = Boolean(open[t.id])
    return (
      <li key={t.id} className={`task-row${expanded ? ' open' : ''}`}>
        <div className="task-line">
          <button className="task-toggle" onClick={() => setOpen({ ...open, [t.id]: !expanded })} title={expanded ? 'Collapse' : 'Details'} aria-expanded={expanded} aria-label={`${t.id} ${t.title}`}>
            <Icon name="chevron" size={12} className={expanded ? '' : 'rot'} />
            <span className="task-id">{t.id}</span>
            <span className="task-title">{t.title}</span>
          </button>
          <select className="task-state" value={t.state} onChange={(e) => void update(t.id, { state: e.target.value as TaskState })} aria-label={`State of ${t.id}`} title="Change the state (done needs a result, blocked a reason: open the row to write one)">
            {TASK_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        {(t.owner || t.deps.length > 0 || t.reason) && (
          <div className="task-meta">
            {t.owner && (
              <button className="link" onClick={() => jump(t.owner!)} title="Jump to the card">
                {titles.get(t.owner) ?? t.owner}
              </button>
            )}
            {t.deps.length > 0 && <span className="muted">after {t.deps.join(', ')}</span>}
            {t.reason && <span className={t.state === 'blocked' ? 'task-reason warn' : 'task-reason muted'}>{t.reason}</span>}
          </div>
        )}
        {expanded && <TaskDetails task={t} creator={t.createdBy === 'owner' ? 'you' : (titles.get(t.createdBy) ?? `card ${t.createdBy}`)} onSave={(patch) => update(t.id, patch)} />}
      </li>
    )
  }

  return (
    <div className="panel tasks">
      <div className="row task-add">
        <input
          className="text"
          placeholder="Add a task…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          aria-label="New task title"
        />
        <button className="btn small" onClick={() => void add()} disabled={!title.trim()}>
          Add
        </button>
      </div>
      {error && <div className="task-error">{error}</div>}
      {tasks.length === 0 && (
        <p className="muted small">
          No tasks yet. The Conductor fills this list as it plans (task_create), claims work for cards and marks it done; you can add tasks here too.
        </p>
      )}
      {GROUPS.map((g) => {
        const list = g.state === 'done' ? [...byState.done, ...byState.dropped] : byState[g.state]
        if (list.length === 0) return null
        const collapsed = g.state === 'done' && !doneOpen
        return (
          <section key={g.state} className="task-group">
            <h4 title={g.hint}>
              {g.state === 'done' ? (
                <button className="link" onClick={() => setDoneOpen(!doneOpen)} aria-expanded={!collapsed}>
                  {g.label} · {list.length} {collapsed ? '▸' : '▾'}
                </button>
              ) : (
                <>
                  {g.label} · {list.length}
                </>
              )}
            </h4>
            {!collapsed && <ul className="task-list">{list.map(row)}</ul>}
          </section>
        )
      })}
    </div>
  )
}

function TaskDetails({ task, creator, onSave }: { task: Task; creator: string; onSave: (patch: { detail?: string; reason?: string; result?: string; state?: TaskState }) => Promise<boolean> }) {
  const [detail, setDetail] = useState(task.detail ?? '')
  const [reason, setReason] = useState(task.reason ?? '')
  const [result, setResult] = useState(task.result ?? '')
  const dirty = detail !== (task.detail ?? '') || reason !== (task.reason ?? '') || result !== (task.result ?? '')
  return (
    <div className="task-details">
      <label>
        <span>Detail</span>
        <textarea className="text" rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="what to do" />
      </label>
      <label>
        <span>Reason</span>
        <textarea className="text" rows={1} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why blocked or dropped (APPROVAL NEEDED: … when it is your call)" />
      </label>
      <label>
        <span>Result</span>
        <textarea className="text" rows={2} value={result} onChange={(e) => setResult(e.target.value)} placeholder="what was done and how it was checked (needed for done)" />
      </label>
      <div className="row right">
        {task.state !== 'done' && (
          <button className="btn small" onClick={() => void onSave({ detail, reason, result: result.trim() || 'done by owner', state: 'done' })}>
            <Icon name="check" size={12} /> Mark done
          </button>
        )}
        <button className="btn small primary" disabled={!dirty} onClick={() => void onSave({ detail, reason, result })}>
          Save
        </button>
      </div>
      <div className="muted small">
        Added by {creator} · {new Date(task.createdAt).toLocaleString()}
      </div>
    </div>
  )
}
