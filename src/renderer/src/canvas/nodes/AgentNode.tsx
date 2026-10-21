import { memo, useEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'
import { useTerminal } from '@/lib/useTerminal'

function AgentNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const ref = useRef<HTMLDivElement>(null)
  const handle = useTerminal(id, ref)
  const restartNode = useBoard((s) => s.restartNode)
  const removeNode = useBoard((s) => s.removeNode)
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const [editing, setEditing] = useState(false)
  const launchedSeq = useRef<number>(-1)
  const status = data.status ?? 'starting'
  const kind = data.kind
  const seq = Number(data.launchSeq) || 0

  // Spawn (or re-spawn) the process once the terminal knows its size.
  useEffect(() => {
    if (!handle) return
    if (launchedSeq.current === seq) return
    launchedSeq.current = seq
    const { term } = handle
    const api = window.ouroboros
    const cwd = data.worktree?.path || data.cwd
    if (kind === 'terminal') {
      void api.pty.spawn({ nodeId: id, cwd, shell: data.shell, cols: term.cols, rows: term.rows, initialCommand: data.initialCommand })
    } else if (kind === 'claude' || kind === 'conductor') {
      void api.claude.launch({ nodeId: id, cwd, shell: data.shell, cols: term.cols, rows: term.rows, kind, claude: data.claude ?? {}, title: data.title })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, seq, id, kind])

  const color = STATUS_COLOR[status]
  return (
    <div className={`agent-node kind-${kind} status-${status}`} style={{ borderColor: selected ? '#38bdf8' : color }}>
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} lineStyle={{ borderColor: '#38bdf8' }} handleStyle={{ background: '#38bdf8' }} />
      <Handle type="target" position={Position.Left} className="port port-in" />
      <Handle type="source" position={Position.Right} className="port port-out" />
      <div className="node-header">
        <span className="status-dot" style={{ background: color }} title={STATUS_LABEL[status]} />
        {editing ? (
          <input
            className="title-input nodrag"
            autoFocus
            defaultValue={data.title}
            onBlur={(e) => {
              updateNodeData(id, { title: e.target.value.trim() || data.title })
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span className="title" onDoubleClick={() => setEditing(true)} title={data.cwd}>
            {kind === 'conductor' ? '🎼 ' : kind === 'claude' ? '✦ ' : '▣ '}
            {data.title}
          </span>
        )}
        <span className="status-text" title={data.statusDetail}>
          {STATUS_LABEL[status]}
          {data.statusDetail ? ` · ${data.statusDetail}` : ''}
        </span>
        <span className="spacer" />
        <button className="icon-btn nodrag" title="Restart" onClick={() => void restartNode(id)}>
          ↻
        </button>
        <button className="icon-btn nodrag" title="Close" onClick={() => void removeNode(id)}>
          ✕
        </button>
      </div>
      <div className="terminal-host nodrag nowheel" ref={ref} onMouseDown={() => handle?.term.focus()} />
    </div>
  )
}

export const AgentNode = memo(AgentNodeImpl)
