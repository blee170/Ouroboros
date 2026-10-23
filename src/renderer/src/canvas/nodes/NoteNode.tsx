import { memo, useEffect, useMemo, useState } from 'react'
import { setDragShield } from '@/lib/dragShield'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { markdownHtml, onMarkdownClick } from '@/lib/markdown'

/** A note shows its markdown rendered (paths open on click); ✎ or a double-click edits it, an empty note starts in the editor. */
function NoteNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const removeNode = useBoard((s) => s.removeNode)
  const [editing, setEditing] = useState(!data.note)
  const [note, setNote] = useState<string | null>(null)
  const html = useMemo(() => (editing ? '' : markdownHtml(data.note ?? '')), [editing, data.note])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])
  return (
    <div className={`note-node${selected ? ' selected' : ''}`}>
      <NodeResizer minWidth={200} minHeight={120} isVisible={selected} lineStyle={{ borderColor: '#facc15' }} handleStyle={{ background: '#facc15', width: 14, height: 14, borderRadius: 3 }} onResizeStart={() => setDragShield(true)} onResizeEnd={() => setDragShield(false)} />
      <div className="node-header">
        <span className="title">📝 {data.title}</span>
        <span className="spacer" />
        <button className={`icon-btn nodrag${editing ? ' active' : ''}`} title={editing ? 'Done editing (shows the note rendered)' : 'Edit the markdown'} aria-label={editing ? 'Done editing' : 'Edit note'} aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
          <Icon name="pencil" size={14} />
        </button>
        <button className="icon-btn nodrag" title="Close" aria-label="Close note" onClick={() => void removeNode(id)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {editing ? (
        <textarea className="note-body nodrag nowheel" autoFocus value={data.note ?? ''} placeholder="Markdown note…" onChange={(e) => updateNodeData(id, { note: e.target.value })} onBlur={() => data.note && setEditing(false)} />
      ) : (
        <div className="note-body note-view md nodrag nowheel" onDoubleClick={() => setEditing(true)} onClick={(e) => void onMarkdownClick(e, data.cwd).then((m) => m && setNote(m), (err: Error) => setNote(err.message))} dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {note && <div className="note-status">{note}</div>}
    </div>
  )
}

export const NoteNode = memo(NoteNodeImpl)
