import { memo } from 'react'
import { Icon } from '@/lib/icons'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { BoardEdge } from '@/store/board'
import { useBoard } from '@/store/board'

function HandoffEdgeImpl(props: EdgeProps<BoardEdge>) {
  const { id, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const select = useBoard((s) => s.select)
  const firing = Boolean(data?.firing)
  // glows while the target works on what this line sent it: the target is working and this line fired at
  // (or just before: the paste reaches the CLI a few seconds before its UserPromptSubmit hook) that start
  const active = useBoard((s) => {
    if (s.nodes.find((n) => n.id === target)?.data.status !== 'working') return false
    const since = s.workingSince[target]
    return since !== undefined && (data?.lastFiredAt ?? 0) >= since - 10_000
  })
  const state = firing ? ' firing' : active ? ' active' : ''
  const mode = data?.mode ?? 'auto'
  const fire = async (): Promise<void> => {
    const r = await window.ouroboros.board.fireHandoff(id)
    if (!r.ok) alert(`Handoff not sent: ${r.error}`)
  }
  return (
    <>
      <BaseEdge id={id} path={path} className={`handoff-edge${state}${selected ? ' selected' : ''}`} markerEnd="url(#handoff-arrow)" />
      <EdgeLabelRenderer>
        <div className={`edge-label nodrag nopan${state}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }} onClick={() => select(null, id)}>
          <span className={`chip ${mode}`}>{mode === 'auto' ? 'auto' : 'manual'}</span>
          <button className="icon-btn" title="Send handoff now" aria-label="Send handoff now" onClick={(e) => { e.stopPropagation(); void fire() }}>
            <Icon name="play" size={11} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const HandoffEdge = memo(HandoffEdgeImpl)
