import { memo } from 'react'
import { setDragShield } from '@/lib/dragShield'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'

function NoteNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const removeNode = useBoard((s) => s.removeNode)
  return (
    <div className={`note-node${selected ? ' selected' : ''}`}>
      <NodeResizer minWidth={200} minHeight={120} isVisible={selected} lineStyle={{ borderColor: '#facc15' }} handleStyle={{ background: '#facc15', width: 14, height: 14, borderRadius: 3 }} onResizeStart={() => setDragShield(true)} onResizeEnd={() => setDragShield(false)} />
      <div className="node-header">
        <span className="title">📝 {data.title}</span>
        <span className="spacer" />
        <button className="icon-btn nodrag" title="Close" aria-label="Close note" onClick={() => void removeNode(id)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <textarea className="note-body nodrag nowheel" value={data.note ?? ''} placeholder="Markdown note…" onChange={(e) => updateNodeData(id, { note: e.target.value })} />
    </div>
  )
}

export const NoteNode = memo(NoteNodeImpl)
