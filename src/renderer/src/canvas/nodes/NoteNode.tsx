import { memo } from 'react'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'

function NoteNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const removeNode = useBoard((s) => s.removeNode)
  return (
    <div className={`note-node${selected ? ' selected' : ''}`}>
      <NodeResizer minWidth={200} minHeight={120} isVisible={selected} lineStyle={{ borderColor: '#facc15' }} handleStyle={{ background: '#facc15' }} />
      <div className="node-header">
        <span className="title">📝 {data.title}</span>
        <span className="spacer" />
        <button className="icon-btn nodrag" title="Close" onClick={() => void removeNode(id)}>
          ✕
        </button>
      </div>
      <textarea className="note-body nodrag nowheel" value={data.note ?? ''} placeholder="Markdown note…" onChange={(e) => updateNodeData(id, { note: e.target.value })} />
    </div>
  )
}

export const NoteNode = memo(NoteNodeImpl)
