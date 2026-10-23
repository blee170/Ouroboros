import { memo, useEffect, useRef, useState } from 'react'
import { setDragShield } from '@/lib/dragShield'
import { Handle, NodeResizer, Position, useStore, type NodeProps } from '@xyflow/react'
import { STATUS_COLOR, STATUS_LABEL } from '@shared/status'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'
import { useTerminal, type TerminalHandle } from '@/lib/useTerminal'
import { FAR_ZOOM, isAtBottom, tailText } from '@/lib/terminalScale'
import { typePrompt } from '@/lib/typePrompt'
import { useCardChanges, useSessionUsage } from '@/lib/useCardInfo'
import { Icon } from '@/lib/icons'

function AgentNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const ref = useRef<HTMLDivElement>(null)
  const zoom = useStore((s) => s.transform[2])
  const handle = useTerminal(id, ref, zoom, (data.kind === 'claude' || data.kind === 'conductor') && (data.engine ?? 'claude') === 'claude')
  const restartNode = useBoard((s) => s.restartNode)
  const removeNode = useBoard((s) => s.removeNode)
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const [editing, setEditing] = useState(false)
  const launchedSeq = useRef<number>(-1)
  // Redraw sharp at the new zoom once the gesture settles (until then the canvas just scales the old frame).
  useEffect(() => {
    if (!handle) return
    const t = setTimeout(() => handle.setZoom(zoom), 80)
    return () => clearTimeout(t)
  }, [zoom, handle])
  // Zoomed far out the terminal is too small to read: the card shows a summary in large type instead.
  const far = zoom < FAR_ZOOM
  // an agent card without a reply yet would show its input box and footer as the "last lines": status only then
  const summary = useFarSummary(handle, far && data.kind !== 'claude' && data.kind !== 'conductor', data.lastAssistantMessage)
  // Jump-to-latest: a card scrolled up (by hand, or by a CLI redraw) offers a way back to the bottom.
  const [scrolledUp, setScrolledUp] = useState(false)
  useEffect(() => {
    if (!handle) return
    const { term } = handle
    const update = (): void => setScrolledUp(!isAtBottom(term))
    const subs = [term.onScroll(update), term.onWriteParsed(update), term.onResize(update)]
    return () => subs.forEach((d) => d.dispose())
  }, [handle])
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
    // a launch that fails (shell typo, missing node for Codex) must not leave the card blank on "Starting"
    const report = (r: { ok: boolean; error?: string }): void => {
      // spawns are throttled: a resize sent while this one waited was dropped, so send the current size once more
      if (r.ok) {
        api.pty.resize(id, term.cols, term.rows)
        return
      }
      term.write(`\r\n\x1b[31m[launch failed]\x1b[0m ${r.error ?? 'unknown error'}\r\n`)
      useBoard.getState().applyStatus({ nodeId: id, status: 'ended', statusDetail: 'launch failed', at: Date.now() })
    }
    if (kind === 'terminal' || kind === 'command') {
      void api.pty.spawn({ nodeId: id, cwd, shell: data.shell, cols: term.cols, rows: term.rows, initialCommand: kind === 'terminal' ? data.initialCommand : undefined }).then(report)
    } else if (kind === 'claude' || kind === 'conductor') {
      void api.claude.launch({ nodeId: id, cwd, shell: data.shell, cols: term.cols, rows: term.rows, kind, engine: data.engine, claude: data.claude ?? {}, title: data.title }).then(report)
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
    <div className={`agent-node kind-${kind} status-${status}${far ? ' far' : ''}`} style={{ borderColor: selected ? 'var(--accent)' : color }}>
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} lineStyle={{ borderColor: 'var(--accent)' }} handleStyle={{ background: 'var(--accent)', width: 14, height: 14, borderRadius: 3 }} onResizeStart={() => setDragShield(true)} onResizeEnd={() => setDragShield(false)} />
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
          <span className="title" onDoubleClick={() => setEditing(true)} title={`${data.title}\n${data.cwd}`}>
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
        {data.lastBriefUrl && (
          <button className="icon-btn nodrag" title={`Open the latest brief in the Briefs card\n${data.lastBriefUrl}`} aria-label="Open the latest brief" onClick={() => void window.ouroboros.brief.open(data.lastBriefUrl as string)}>
            <Icon name="brief" size={14} />
          </button>
        )}
        {changes && changes.repo && changes.files.length > 0 && (
          <button className="changes-badge nodrag" title={`${changes.files.length} changed file(s) on ${changes.branch ?? '?'} — click to review in the Inspector`} onClick={() => select(id, null)}>
            <span className="add">+{changes.added}</span> <span className="del">−{changes.deleted}</span>
          </button>
        )}
        <button className="icon-btn nodrag" title="Restart" aria-label="Restart" onClick={() => void restartNode(id)}>
          <Icon name="refresh" size={14} />
        </button>
        <button className="icon-btn nodrag" title="Close" aria-label="Close card" onClick={() => void removeNode(id)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="scale-wrap">
        {/* sized and scaled by useTerminal (render scale), not by React: a re-render must not undo it */}
        <div className="terminal-host nodrag nowheel" ref={ref} onMouseDown={() => handle?.term.focus()} />
        {far && (
          <div className="card-summary">
            <div className="summary-title">{data.title}</div>
            <div className="summary-status">
              {STATUS_LABEL[status]}
              {data.statusDetail ? ` · ${data.statusDetail}` : ''}
            </div>
            {summary && <div className="summary-text">{summary}</div>}
          </div>
        )}
        {!far && scrolledUp && (
          <button
            className="jump-bottom nodrag"
            title="Scroll to the latest output"
            onClick={() => {
              handle?.term.scrollToBottom()
              handle?.term.focus()
            }}
          >
            <Icon name="down" size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * What a card says when zoomed far out: the last reply of an agent, else the last lines of its terminal.
 * Read only while far, at most twice a second.
 */
function useFarSummary(handle: TerminalHandle | null, far: boolean, lastReply: string | undefined): string {
  const [tail, setTail] = useState('')
  useEffect(() => {
    if (!far || !handle || lastReply) return
    const { term } = handle
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = (): void => {
      timer = null
      setTail(tailText(term, 12))
    }
    read()
    const sub = term.onWriteParsed(() => {
      if (!timer) timer = setTimeout(read, 500)
    })
    return () => {
      sub.dispose()
      if (timer) clearTimeout(timer)
    }
  }, [far, handle, lastReply])
  return lastReply || tail
}

export const AgentNode = memo(AgentNodeImpl)
