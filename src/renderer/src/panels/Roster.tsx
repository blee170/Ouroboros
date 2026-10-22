import { useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useBoard } from '@/store/board'
import type { SkillEntry } from '@shared/protocol'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import { typePrompt } from '@/lib/typePrompt'
import { ROSTER_GROUPS, rosterOrder } from '@/lib/rosterOrder'

export function Roster() {
  const allNodes = useBoard((s) => s.nodes)
  const nodes = useMemo(() => rosterOrder(allNodes), [allNodes])
  const ordered = nodes
  const select = useBoard((s) => s.select)
  const rf = useReactFlow()
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [text, setText] = useState('')
  const projectRoot = useBoard((s) => s.projectRoot)
  // slash-command picker, like Claude Code's own: "/" at the start lists the commands and skills a card offers
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [pick, setPick] = useState(0)
  const [pickerClosed, setPickerClosed] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const slash = /^\/(\S*)$/.exec(text)
  const query = slash?.[1].toLowerCase() ?? ''
  const matches = slash && !pickerClosed && skills ? skills.filter((s) => s.name.toLowerCase().includes(query)).sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query))).slice(0, 12) : []
  const loadSkills = (): void => {
    if (skills) return
    window.ouroboros.skills.list(projectRoot ?? '').then(setSkills, () => setSkills([]))
  }
  const complete = (s: SkillEntry): void => {
    setText(`/${s.name} `)
    setPickerClosed(true)
    inputRef.current?.focus()
  }
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!matches.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      complete(matches[Math.min(pick, matches.length - 1)])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setPickerClosed(true)
    }
  }

  const focus = (id: string): void => {
    const n = rf.getNode(id)
    if (n) void rf.fitView({ nodes: [{ id }], duration: 400, padding: 0.3 })
    select(id, null)
  }
  const targets = nodes.filter((n) => checked[n.id] && n.data.kind !== 'external')
  const broadcast = (): void => {
    if (!text.trim() || !targets.length) return
    for (const n of targets) typePrompt(n.id, text)
    setText('')
  }

  return (
    <div className="panel roster">
      <h3>Roster</h3>
      {nodes.length === 0 && <div className="muted small">No agents yet.</div>}
      <ul className="roster-list">
        {ROSTER_GROUPS.map((g) => {
          const members = nodes.filter((n) => g.statuses.includes(n.data.status ?? 'starting'))
          if (!members.length) return null
          return [
            <li key={`h-${g.label}`} className="roster-group">
              <span>{g.label}</span>
              <span className="muted small">{members.length}</span>
              <button className="link small" title="Check all in this group" onClick={() => setChecked({ ...checked, ...Object.fromEntries(members.filter((m) => m.data.kind !== 'external').map((m) => [m.id, true])) })}>
                select
              </button>
            </li>,
            ...members.map((n) => {
          const st = n.data.status ?? 'starting'
          return (
            <li key={n.id} className={`roster-item status-${st}`}>
              <input type="checkbox" disabled={n.data.kind === 'external'} checked={Boolean(checked[n.id])} onChange={(e) => setChecked({ ...checked, [n.id]: e.target.checked })} />
              <button className="roster-main" onClick={() => focus(n.id)}>
                <span className="status-dot" style={{ background: STATUS_COLOR[st] }} />
                <span className="title">{n.data.title}</span>
                {ordered.indexOf(n) < 9 && <kbd className="hotkey">Ctrl+{ordered.indexOf(n) + 1}</kbd>}
                <span className="muted small">{STATUS_LABEL[st]}{n.data.statusDetail ? ` · ${n.data.statusDetail}` : ''}</span>
                {n.data.lastAssistantMessage && <span className="small clamp">{n.data.lastAssistantMessage}</span>}
              </button>
            </li>
          )
            })
          ]
        })}
      </ul>
      <div className="block">
        <div className="muted small">Send to {targets.length} checked card{targets.length === 1 ? '' : 's'} (Ctrl+1…9 focuses cards, Ctrl+F finds one by title)</div>
        <textarea
          ref={inputRef}
          rows={3}
          value={text}
          placeholder="Type a prompt for all checked agents… ( / lists commands and skills)"
          onFocus={loadSkills}
          onKeyDown={onComposerKey}
          onChange={(e) => {
            setText(e.target.value)
            setPick(0)
            setPickerClosed(false)
            if (e.target.value.startsWith('/')) loadSkills()
          }}
        />
        {matches.length > 0 && (
          <ul className="skill-list" role="listbox">
            {matches.map((s, i) => (
              <li key={s.name} role="option" aria-selected={i === pick} className={`skill-item${i === pick ? ' active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => complete(s)} title={s.description}>
                <span className="name">/{s.name}</span>
                {s.description && <span className="desc">{s.description}</span>}
              </li>
            ))}
          </ul>
        )}
        <button className="btn" disabled={!targets.length || !text.trim()} onClick={broadcast}>
          Send to {targets.length}
        </button>
      </div>
    </div>
  )
}
