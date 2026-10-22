import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'

function ExternalNodeImpl({ id, data }: NodeProps<BoardNode>) {
  const pullExternal = useBoard((s) => s.pullExternal)
  const status = data.status ?? 'idle'
  return (
    <div className="external-node" style={{ borderColor: STATUS_COLOR[status] }}>
      <div className="node-header">
        <span className="status-dot" style={{ background: STATUS_COLOR[status] }} />
        <span className="title" title={data.cwd}>
          ⇢ {data.title}
        </span>
        <span className="status-text">{STATUS_LABEL[status]}</span>
      </div>
      <div className="external-body">
        <div className="muted small">{data.statusDetail ?? 'Claude Code session running outside Ouroboros'}</div>
        {data.lastAssistantMessage && <div className="small clamp">{data.lastAssistantMessage}</div>}
        <button className="btn small nodrag" onClick={() => pullExternal(id)}>
          Pull into canvas (resume here)
        </button>
      </div>
    </div>
  )
}

export const ExternalNode = memo(ExternalNodeImpl)
