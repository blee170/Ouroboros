import { useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useBoard, type BoardNode } from '@/store/board'
import type { SkillEntry } from '@shared/protocol'
import { STATUS_LABEL } from '@shared/status'
import { silentMinutes } from '@shared/attention'
import { typePrompt } from '@/lib/typePrompt'
import { ROSTER_GROUPS, groupRows } from '@/lib/rosterOrder'
import { Icon } from '@/lib/icons'
import { StateGlyph } from '@/lib/StateGlyph'
import { kindIcon } from '@/lib/cardKinds'
import { setDragShield } from '@/lib/dragShield'

const WIDTH_KEY = 'ouroboros.sidebarWidth'
/** 220–500px, and never so wide that the canvas (320px at least) and the Inspector lose their room. */
const clampWidth = (w: number, inspectorOpen = false): number => Math.min(500, Math.max(220, Math.min(Math.round(w), window.innerWidth - (inspectorOpen ? 350 : 0) - 320)))

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** "now", "3m", "2h", "1d": when the card last did anything. */
function ago(t: number | undefined, now: number): string {
  if (!t) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * The left sidebar: every agent card by state (what needs you first), workers under their Conductor, a search
 * row, the project with its counts, and at the bottom a composer that sends one prompt to the checked cards.
 * Rows follow the store's settled order (a card moves section a few seconds after it changed, its glyph at
 * once); Ctrl+1…9 follow the same order. A card with a result not yet looked at is bold. The edge drags
 * (220–500px, remembered per machine).
 */
export function Sidebar() {
  const allNodes = useBoard((s) => s.nodes)
  const settled = useBoard((s) => s.settledRoster)
  const unread = useBoard((s) => s.attention.unread)
  const tasks = useBoard((s) => s.tasks)
  // the task each card is on (doing or blocked), for the row's second line
  const taskOf = useMemo(() => {
    const m: Record<string, { id: string; title: string }> = {}
    for (const t of tasks) if (t.owner && (t.state === 'doing' || t.state === 'blocked') && !m[t.owner]) m[t.owner] = { id: t.id, title: t.title }
    return m
  }, [tasks])
  // the settled rows, each with its live card (a closed card leaves the settled list at once, so none is missing)
  const rows = useMemo(() => {
    const live = new Map(allNodes.map((n) => [n.id, n]))
    return settled.flatMap((r) => {
      const n = live.get(r.id)
      return n ? [{ row: r, node: n }] : []
    })
  }, [settled, allNodes])
  const ordered = useMemo(() => rows.map((r) => r.node), [rows])
  const select = useBoard((s) => s.select)
  const selectedId = useBoard((s) => s.selectedNodeId)
  const projectRoot = useBoard((s) => s.projectRoot)
  const rf = useReactFlow()
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // width: a drag on the right edge, remembered in localStorage (a per-machine convenience, not board data)
  const [width, setWidth] = useState(() => {
    try {
      return clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || 280)
    } catch {
      return 280
    }
  })
  const [dragging, setDragging] = useState(false)
  const inspectorOpen = useBoard((s) => s.inspectorOpen)
  // the drag in flight, so an unmount mid-drag (the sidebar toggled with a key) still releases everything
  const endDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => endDrag.current?.(), [])
  const onResizeStart = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let w = width
    setDragging(true)
    setDragShield(true) // webviews on the canvas must not swallow the pointer mid-drag
    document.body.classList.add('ouro-resizing')
    const up = (): void => {
      endDrag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setDragging(false)
      setDragShield(false)
      document.body.classList.remove('ouro-resizing')
      try {
        localStorage.setItem(WIDTH_KEY, String(w))
      } catch {
        /* private window or blocked storage: the width just does not persist */
      }
    }
    const move = (ev: MouseEvent): void => {
      if (ev.buttons === 0) return up() // the mouseup happened outside the window (Alt+Tab mid-drag)
      w = clampWidth(startW + ev.clientX - startX, inspectorOpen)
      setWidth(w)
    }
    endDrag.current = up
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // slash-command picker, like Claude Code's own: "/" at the start lists the commands and skills a card offers
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [pick, setPick] = useState(0)
  const [pickerClosed, setPickerClosed] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const slash = /^\/(\S*)$/.exec(text)
  const slashQuery = slash?.[1].toLowerCase() ?? ''
  const matches = slash && !pickerClosed && skills ? skills.filter((s) => s.name.toLowerCase().includes(slashQuery)).sort((a, b) => Number(b.name.toLowerCase().startsWith(slashQuery)) - Number(a.name.toLowerCase().startsWith(slashQuery))).slice(0, 12) : []
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
  const targets = ordered.filter((n) => checked[n.id] && n.data.kind !== 'external')
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

  // the search narrows the rows; the hotkeys keep following the full order
  const q = query.trim().toLowerCase()
  const visible = q ? rows.filter(({ node: n }) => `${n.data.title} ${n.data.statusDetail ?? ''}`.toLowerCase().includes(q)) : rows
  // the header counts are live (the status bar's are too); only the rows wait to move
  const count = (...statuses: string[]): number => ordered.filter((n) => statuses.includes(n.data.status ?? 'starting')).length
  const counts = [
    { status: 'working' as const, n: count('working', 'starting'), label: 'working' },
    { status: 'needs-you' as const, n: count('needs-you'), label: 'need you' },
    { status: 'done' as const, n: count('done'), label: 'ready to review' }
  ].filter((c) => c.n > 0)

  const row = (n: BoardNode, depth: number): React.ReactElement => {
    const st = n.data.status ?? 'starting'
    const idx = ordered.indexOf(n)
    const KindIcon = kindIcon(n.data.kind, n.data.engine)
    const when = ago(n.data.lastEventAt, now)
    const silent = silentMinutes(st, n.data.lastEventAt, now)
    const isUnread = n.id in unread
    return (
      <li key={n.id} className={`sb-item${n.id === selectedId ? ' selected' : ''}${isUnread ? ' unread' : ''}`} style={depth ? { marginLeft: 6 + depth * 20 } : undefined}>
        <input type="checkbox" disabled={n.data.kind === 'external'} checked={Boolean(checked[n.id])} onChange={(e) => setChecked({ ...checked, [n.id]: e.target.checked })} aria-label={`Send to ${n.data.title}`} />
        <button className="sb-main" onClick={() => focus(n.id)} title={`${n.data.title}${isUnread ? ' · not looked at yet' : ''}\n${n.data.worktree?.path || n.data.cwd}`}>
          <StateGlyph status={st} decorative />
          <span className="title">
            <KindIcon className="ico" size={13} aria-hidden="true" />
            <span>{n.data.title}</span>
            {isUnread && <span className="sr-only">(unread)</span>}
          </span>
          <span className="right">
            {idx >= 0 && idx < 9 && <kbd className="hotkey">Ctrl+{idx + 1}</kbd>}
            {when && <span title={new Date(n.data.lastEventAt as number).toLocaleString()}>{when}</span>}
          </span>
          <span className="detail">
            {STATUS_LABEL[st]}
            {silent ? <span className="silent" title="Working, but no hook event for a while: a long tool call, or a stall"> · no update for {silent}m</span> : n.data.statusDetail ? ` · ${n.data.statusDetail}` : ''}
          </span>
          {taskOf[n.id] && (
            <span className="task" title={`On task ${taskOf[n.id].id}: ${taskOf[n.id].title}`}>
              {taskOf[n.id].id} · {taskOf[n.id].title}
            </span>
          )}
          {n.data.lastAssistantMessage && <span className="last-reply clamp">{n.data.lastAssistantMessage}</span>}
        </button>
      </li>
    )
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sb-search">
        <Icon name="search" size={14} />
        <input value={query} placeholder="Search cards" onChange={(e) => setQuery(e.target.value)} aria-label="Search cards" />
        {query && (
          <button className="icon-btn" title="Clear" aria-label="Clear search" onClick={() => setQuery('')}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      <div className="sb-project">
        <span className="name" title={projectRoot}>
          {basename(projectRoot)}
        </span>
        <span className="counts" title={counts.length ? counts.map((c) => `${c.n} ${c.label}`).join(' · ') : 'No agent cards yet'}>
          {counts.length === 0 && <span>{ordered.length === 0 ? 'no cards' : `${ordered.length} idle`}</span>}
          {counts.map((c) => (
            <span key={c.status}>
              <StateGlyph status={c.status} size={10} title={`${c.n} ${c.label}`} />
              {c.n}
            </span>
          ))}
        </span>
      </div>
      <ul className="sb-list">
        {ordered.length === 0 && <li className="sb-empty">No cards yet. New card in the title bar, or right-click the canvas.</li>}
        {ordered.length > 0 && visible.length === 0 && <li className="sb-empty">No card matches “{query.trim()}”.</li>}
        {ROSTER_GROUPS.map((g) => {
          // sections follow the settled status, so a row keeps its place until the order settles
          const members = visible.filter(({ row: r }) => g.statuses.includes(r.data.status))
          if (!members.length) return null
          const live = new Map(members.map((m) => [m.row.id, m.node]))
          return [
            <li key={`h-${g.label}`} className="sb-section">
              <span>{g.label}</span>
              <span className="count">{members.length}</span>
              <button className="link" title="Check every card in this section" onClick={() => setChecked({ ...checked, ...Object.fromEntries(members.filter((m) => m.node.data.kind !== 'external').map((m) => [m.row.id, true])) })}>
                select
              </button>
            </li>,
            ...groupRows(members.map((m) => m.row)).map((r) => row(live.get(r.node.id) as BoardNode, r.depth))
          ]
        })}
      </ul>
      <div className="sb-composer">
        <textarea
          ref={inputRef}
          rows={2}
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
        <div className="foot">
          <span>{targets.length ? `To ${targets.length} checked card${targets.length === 1 ? '' : 's'}` : 'Check cards above to send to them'}</span>
          <button className="btn primary small" disabled={!targets.length || (!text.trim() && !files.length) || sending} onClick={() => void broadcast()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
      <div className={`sb-resize${dragging ? ' dragging' : ''}`} onMouseDown={onResizeStart} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize" />
    </aside>
  )
}
