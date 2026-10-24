import { useEffect, useMemo, useRef, useState } from 'react'
import { STATUS_LABEL } from '@shared/status'
import { useBoard, type BoardNode } from '@/store/board'
import { Icon } from '@/lib/icons'
import { StateGlyph } from '@/lib/StateGlyph'
import { kindIcon } from '@/lib/cardKinds'

/**
 * Jump to… (Ctrl+J): every agent card in sidebar order, narrowed as you type (title, state, detail), ↑↓ to
 * pick, Enter to jump, Escape to close. Cards that need you come first because the sidebar order does.
 */
export function JumpPalette({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const nodes = useBoard((s) => s.nodes)
  const settled = useBoard((s) => s.settledRoster)
  const unread = useBoard((s) => s.attention.unread)
  const [q, setQ] = useState('')
  const [pick, setPick] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const ordered = useMemo(() => settled.map((r) => nodes.find((n) => n.id === r.id)).filter((n): n is BoardNode => Boolean(n)), [settled, nodes])
  const needle = q.trim().toLowerCase()
  const rows = needle ? ordered.filter((n) => `${n.data.title} ${STATUS_LABEL[n.data.status ?? 'starting']} ${n.data.statusDetail ?? ''}`.toLowerCase().includes(needle)) : ordered
  const current = Math.min(pick, Math.max(0, rows.length - 1))
  useEffect(() => {
    listRef.current?.children[current]?.scrollIntoView({ block: 'nearest' })
  }, [current])
  const choose = (n: BoardNode | undefined): void => {
    if (!n) return
    onPick(n.id)
    onClose()
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length) setPick((p) => (Math.min(p, rows.length - 1) + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(rows[current])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Jump to a card" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input">
          <Icon name="search" size={14} />
          <input
            autoFocus
            value={q}
            placeholder="Jump to a card…"
            role="combobox"
            aria-label="Jump to a card"
            aria-expanded="true"
            aria-controls="jump-palette-list"
            aria-activedescendant={rows[current] ? `jump-${rows[current].id}` : undefined}
            onChange={(e) => {
              setQ(e.target.value)
              setPick(0)
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" id="jump-palette-list" ref={listRef} role="listbox">
          {rows.length === 0 && <li className="palette-empty">{ordered.length ? `No card matches “${q.trim()}”.` : 'No agent cards yet.'}</li>}
          {rows.map((n, i) => {
            const st = n.data.status ?? 'starting'
            const KindIcon = kindIcon(n.data.kind, n.data.engine)
            const idx = ordered.indexOf(n)
            return (
              <li key={n.id} id={`jump-${n.id}`} role="option" aria-selected={i === current} className={`palette-row${i === current ? ' active' : ''}${n.id in unread ? ' unread' : ''}`} onMouseMove={() => setPick(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(n)}>
                <StateGlyph status={st} size={12} decorative />
                <KindIcon className="ico" size={13} aria-hidden="true" />
                <span className="title">
                  {n.data.title}
                  {n.id in unread && <span className="sr-only"> (unread)</span>}
                </span>
                <span className="detail">
                  {STATUS_LABEL[st]}
                  {n.data.statusDetail ? ` · ${n.data.statusDetail}` : ''}
                </span>
                {idx >= 0 && idx < 9 && <kbd>Ctrl+{idx + 1}</kbd>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
