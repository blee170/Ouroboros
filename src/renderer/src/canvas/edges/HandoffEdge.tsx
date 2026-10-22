import { memo } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { BoardEdge } from '@/store/board'
import { useBoard } from '@/store/board'

function HandoffEdgeImpl(props: EdgeProps<BoardEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const select = useBoard((s) => s.select)
  const firing = Boolean(data?.firing)
  const mode = data?.mode ?? 'auto'
  const fire = async (): Promise<void> => {
    const r = await window.ouroboros.board.fireHandoff(id)
    if (!r.ok) alert(`Handoff not sent: ${r.error}`)
  }
  return (
    <>
      <BaseEdge id={id} path={path} className={`handoff-edge${firing ? ' firing' : ''}${selected ? ' selected' : ''}`} markerEnd="url(#handoff-arrow)" />
      <EdgeLabelRenderer>
        <div className={`edge-label nodrag nopan${firing ? ' firing' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }} onClick={() => select(null, id)}>
          <span className={`chip ${mode}`}>{mode === 'auto' ? 'auto' : 'manual'}</span>
          <button className="icon-btn" title="Send handoff now" onClick={(e) => { e.stopPropagation(); void fire() }}>
            ▶
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const HandoffEdge = memo(HandoffEdgeImpl)
