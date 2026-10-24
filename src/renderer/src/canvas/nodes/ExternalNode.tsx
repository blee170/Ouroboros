import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import { STATUS_LABEL } from '@shared/status'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'
import { StateGlyph } from '@/lib/StateGlyph'
import { kindIcon } from '@/lib/cardKinds'

const ExternalIcon = kindIcon('external')

function ExternalNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const pullExternal = useBoard((s) => s.pullExternal)
  const status = data.status ?? 'idle'
  return (
    <div className={`external-node${selected ? ' selected' : ''}`}>
      <div className="node-header">
        <StateGlyph status={status} />
        <span className="title" title={data.cwd}>
          <ExternalIcon className="ico kind" size={13} aria-hidden="true" />
          <span>{data.title}</span>
        </span>
        <span className="status-text">{STATUS_LABEL[status]}</span>
      </div>
      <div className="external-body">
        <div className="muted small clamp">{data.statusDetail ?? 'Claude Code session running outside Ouroboros'}</div>
        {data.lastAssistantMessage && <div className="small clamp">{data.lastAssistantMessage}</div>}
        <button className="btn small nodrag" onClick={() => pullExternal(id)}>
          Pull into canvas (resume here)
        </button>
      </div>
    </div>
  )
}

export const ExternalNode = memo(ExternalNodeImpl)
