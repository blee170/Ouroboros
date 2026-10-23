import { useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useBoard } from '@/store/board'
import type { SkillEntry } from '@shared/protocol'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import { typePrompt } from '@/lib/typePrompt'
import { ROSTER_GROUPS, rosterOrder } from '@/lib/rosterOrder'
import { Icon } from '@/lib/icons'

/** Every card by state, and a composer that sends one prompt to the checked ones. The list scrolls; the composer stays. */
export function Roster() {
  const allNodes = useBoard((s) => s.nodes)
  const nodes = useMemo(() => rosterOrder(allNodes), [allNodes])
  const ordered = nodes
  const select = useBoard((s) => s.select)
  const selectedId = useBoard((s) => s.selectedNodeId)
  const rf = useReactFlow()
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState(false)
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
  // Screenshots pasted or files dropped into the composer travel with the prompt: a Claude Code card gets an
  // image as its own [Image #N] chip, every other card (and any non-image file) gets the path typed in.
  const [files, setFiles] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const quote = (p: string): string => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)
  const isImage = (p: string): boolean => /\.(png|jpe?g|gif|webp|bmp)$/i.test(p)
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    e.preventDefault()
    void Promise.all(images.map(async (f) => window.ouroboros.files.saveImage(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1] || 'png'))).then((paths) => setFiles((cur) => [...cur, ...paths]))
  }
  const onComposerDrop = (e: React.DragEvent<HTMLTextAreaElement>): void => {
    const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.ouroboros.files.pathFor(f)).filter(Boolean)
    if (!paths.length) return
    e.preventDefault()
    setFiles((cur) => [...cur, ...paths])
  }
  const broadcast = async (): Promise<void> => {
    if ((!text.trim() && !files.length) || !targets.length || sending) return
    setSending(true)
    try {
      for (const n of targets) {
        const claude = (n.data.kind === 'claude' || n.data.kind === 'conductor') && (n.data.engine ?? 'claude') === 'claude'
        const typed: string[] = []
        for (const p of files) {
          if (claude && isImage(p) && (await window.ouroboros.pty.pasteImage(n.id, p)).ok) continue
          typed.push(quote(p))
        }
        const prompt = [text.trim(), ...typed].filter(Boolean).join(' ')
        if (prompt) typePrompt(n.id, prompt)
      }
      setText('')
      setFiles([])
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="panel roster">
      <h3>
        Roster <span className="count">{nodes.length}</span>
        <button className="icon-btn" title={collapsed ? 'Show the list' : 'Hide the list (the prompt box stays)'} aria-expanded={!collapsed} onClick={() => setCollapsed((v) => !v)}>
          <Icon name="chevron" size={14} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 150ms' }} />
        </button>
      </h3>
      {!collapsed && (
        <div className="roster-scroll">
          {nodes.length === 0 && <div className="muted small">No cards yet. Add one from the toolbar or right-click the canvas.</div>}
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
                  const idx = ordered.indexOf(n)
                  return (
                    <li key={n.id} className={`roster-item status-${st}${n.id === selectedId ? ' selected' : ''}`}>
                      <input type="checkbox" disabled={n.data.kind === 'external'} checked={Boolean(checked[n.id])} onChange={(e) => setChecked({ ...checked, [n.id]: e.target.checked })} aria-label={`Send to ${n.data.title}`} />
                      <button className="roster-main" onClick={() => focus(n.id)}>
                        <span className="status-dot" style={{ background: STATUS_COLOR[st] }} />
                        <span className="title">{n.data.title}</span>
                        {idx < 9 && <kbd className="hotkey">Ctrl+{idx + 1}</kbd>}
                        <span className="muted small">
                          {STATUS_LABEL[st]}
                          {n.data.statusDetail ? ` · ${n.data.statusDetail}` : ''}
                        </span>
                        {n.data.lastAssistantMessage && <span className="small clamp">{n.data.lastAssistantMessage}</span>}
                      </button>
                    </li>
                  )
                })
              ]
            })}
          </ul>
        </div>
      )}
      <div className="composer">
        <div className="muted small">Send to {targets.length} checked card{targets.length === 1 ? '' : 's'} · Ctrl+1…9 focuses a card, Ctrl+F finds one by title</div>
        <textarea
          ref={inputRef}
          rows={3}
          value={text}
          placeholder="Prompt for every checked card… ( / lists commands and skills; paste or drop screenshots)"
          onFocus={loadSkills}
          onKeyDown={onComposerKey}
          onPaste={onComposerPaste}
          onDrop={onComposerDrop}
          onDragOver={(e) => {
            if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
          }}
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
        {files.length > 0 && (
          <ul className="attach-list">
            {files.map((p, i) => (
              <li key={`${p}-${i}`} className="attach" title={p}>
                <Icon name={isImage(p) ? 'image' : 'clip'} size={14} /> {p.split(/[\\/]/).pop()}
                <button className="icon-btn" title="Remove" aria-label="Remove attachment" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="btn" disabled={!targets.length || (!text.trim() && !files.length) || sending} onClick={() => void broadcast()}>
          {sending ? 'Sending…' : `Send to ${targets.length}`}
        </button>
      </div>
    </div>
  )
}
