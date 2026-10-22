import { memo, useEffect, useRef, useState } from 'react'
import { setDragShield } from '@/lib/dragShield'
import { Handle, NodeResizer, Position, useStore, type NodeProps } from '@xyflow/react'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'
import { useTerminal } from '@/lib/useTerminal'
import { typePrompt } from '@/lib/typePrompt'
import { useCardChanges, useSessionUsage } from '@/lib/useCardInfo'

function AgentNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const ref = useRef<HTMLDivElement>(null)
  const handle = useTerminal(id, ref)
  const restartNode = useBoard((s) => s.restartNode)
  const removeNode = useBoard((s) => s.removeNode)
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const [editing, setEditing] = useState(false)
  const launchedSeq = useRef<number>(-1)
  const zoom = useStore((s) => s.transform[2])
  // Keep the terminal DOM at screen scale (undo the canvas transform) and scale the font instead.
  useEffect(() => {
    if (!handle) return
    const t = setTimeout(() => handle.setZoom(zoom), 80)
    return () => clearTimeout(t)
  }, [zoom, handle])
  const status = data.status ?? 'starting'
  const kind = data.kind
  const seq = Number(data.launchSeq) || 0
  const changes = useCardChanges(data.worktree?.path || data.cwd, status)
  const usage = useSessionUsage(data.sessionId, status, (kind === 'claude' || kind === 'conductor') && (data.engine ?? 'claude') === 'claude')
  const select = useBoard((s) => s.select)

  // Spawn (or re-spawn) the process once the terminal knows its size.
  useEffect(() => {
    if (!handle) return
    if (launchedSeq.current === seq) return
    launchedSeq.current = seq
    const { term } = handle
    const api = window.ouroboros
    const cwd = data.worktree?.path || data.cwd
    if (kind === 'terminal' || kind === 'command') {
      void api.pty.spawn({ nodeId: id, cwd, shell: data.shell, cols: term.cols, rows: term.rows, initialCommand: kind === 'terminal' ? data.initialCommand : undefined })
    } else if (kind === 'claude' || kind === 'conductor') {
      void api.claude.launch({ nodeId: id, cwd, shell: data.shell, cols: term.cols, rows: term.rows, kind, engine: data.engine, claude: data.claude ?? {}, title: data.title })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, seq, id, kind])

  // First instruction: typed once the session reports idle/ready, then removed from the card data.
  useEffect(() => {
    if (!data.initialPrompt || status !== 'idle') return
    const prompt = data.initialPrompt
    updateNodeData(id, { initialPrompt: undefined })
    setTimeout(() => typePrompt(id, prompt, 200), 1200)
  }, [data.initialPrompt, status, id, updateNodeData])

  const color = STATUS_COLOR[status]
  return (
    <div className={`agent-node kind-${kind} status-${status}`} style={{ borderColor: selected ? '#38bdf8' : color }}>
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} lineStyle={{ borderColor: '#38bdf8' }} handleStyle={{ background: '#38bdf8', width: 14, height: 14, borderRadius: 3 }} onResizeStart={() => setDragShield(true)} onResizeEnd={() => setDragShield(false)} />
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
            {kind === 'conductor' ? '🎼 ' : kind === 'claude' ? (data.engine === 'codex' ? '◎ ' : data.engine === 'gemini' ? '✧ ' : '✦ ') : kind === 'command' ? '⚡ ' : '▣ '}
            {data.title}
          </span>
        )}
        <span className="status-text" title={data.statusDetail}>
          {STATUS_LABEL[status]}
          {data.statusDetail ? ` · ${data.statusDetail}` : ''}
        </span>
        <span className="spacer" />
        {usage && (
          <span
            className={`ctx-meter nodrag ${usage.contextTokens / usage.contextWindow > 0.7 ? 'hot' : ''}`}
            title={`Context: ${usage.contextTokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${usage.model ?? 'model?'}). Past 70%: ask the card to /compact.`}
          >
            <span className="bar" style={{ width: `${Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100))}%` }} />
            <span className="label">{Math.round(usage.contextTokens / 1000)}k</span>
          </span>
        )}
        {kind === 'conductor' && data.lastBriefUrl && (
          <button className="icon-btn nodrag" title={`Open the latest brief in the 📄 Briefs card\n${data.lastBriefUrl}`} onClick={() => void window.ouroboros.brief.open(data.lastBriefUrl as string)}>
            📄
          </button>
        )}
        {changes && changes.repo && changes.files.length > 0 && (
          <button className="changes-badge nodrag" title={`${changes.files.length} changed file(s) on ${changes.branch ?? '?'} — click to review in the Inspector`} onClick={() => select(id, null)}>
            <span className="add">+{changes.added}</span> <span className="del">−{changes.deleted}</span>
          </button>
        )}
        <button className="icon-btn nodrag" title="Restart" onClick={() => void restartNode(id)}>
          ↻
        </button>
        <button className="icon-btn nodrag" title="Close" onClick={() => void removeNode(id)}>
          ✕
        </button>
      </div>
      <div className="scale-wrap">
        <div
          className="terminal-host nodrag nowheel"
          ref={ref}
          style={{ transform: `scale(${1 / zoom})`, width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
          onMouseDown={() => handle?.term.focus()}
        />
      </div>
    </div>
  )
}

export const AgentNode = memo(AgentNodeImpl)
