import { memo, useEffect, useRef, useState } from 'react'
import { setDragShield } from '@/lib/dragShield'
import { Handle, NodeResizer, Position, useStore, type NodeProps } from '@xyflow/react'
import { STATUS_LABEL } from '@shared/status'
import { shownDetail } from '@shared/doing'
import { elapsedText } from '@shared/activity'
import type { BoardNode } from '@/store/board'
import { StateGlyph } from '@/lib/StateGlyph'
import { kindIcon } from '@/lib/cardKinds'
import { syncNow, takeLive, useBoard } from '@/store/board'
import { launchMode } from '@shared/reattach'
import { useTerminal, type TerminalHandle } from '@/lib/useTerminal'
import { FAR_ZOOM, isAtBottom, tailText, wantsWebgl } from '@/lib/terminalScale'
import { typePrompt } from '@/lib/typePrompt'
import { useCardChanges } from '@/lib/useCardInfo'
import { Icon } from '@/lib/icons'
import { cardView, chatCapable } from '@shared/chat'
import { ChatView } from './ChatView'

function AgentNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const ref = useRef<HTMLDivElement>(null)
  const zoom = useStore((s) => s.transform[2])
  const handle = useTerminal(id, ref, zoom, (data.kind === 'claude' || data.kind === 'conductor') && (data.engine ?? 'claude') === 'claude')
  const restartNode = useBoard((s) => s.restartNode)
  const removeNode = useBoard((s) => s.removeNode)
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const [editing, setEditing] = useState(false)
  // Chat view: the same session shown as a conversation. The terminal stays mounted underneath at its own size,
  // so the PTY, the hooks and everything that reads the terminal work as before.
  const view = cardView(data, useBoard((s) => s.settings.defaultCardView))
  // the terminal shown for a moment to answer a question the card asks; the chat returns when the card carries on
  const [peek, setPeek] = useState(false)
  useEffect(() => {
    if (data.status !== 'needs-you') setPeek(false)
  }, [data.status])
  const chat = view === 'chat' && !peek
  // once shown the chat stays mounted (hidden under the terminal view): a prompt sent from it that the conversation
  // has not shown yet must still be there, marked, when the owner comes back
  const [chatMounted, setChatMounted] = useState(false)
  useEffect(() => {
    if (view === 'chat') setChatMounted(true)
  }, [view])
  // the terminal under the chat must not keep the keyboard: keys typed "into the chat" would go to Claude Code unseen
  useEffect(() => {
    if (chat) handle?.term.blur()
  }, [chat, handle])
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
  const detail = shownDetail(data)
  const kind = data.kind
  const seq = Number(data.launchSeq) || 0
  const changes = useCardChanges(data.worktree?.path || data.cwd, status)
  const asleep = data.asleep === true
  // an ended or asleep card gives its WebGL context back; a restart (or a wake) takes one again
  useEffect(() => {
    handle?.setWebgl(wantsWebgl(status, asleep))
  }, [handle, status, asleep])
  const usage = useBoard((s) => s.usage[id])
  // subagents the card runs right now (from its hooks)
  const subagents = useBoard((s) => s.activity[id]?.running)
  // board mail waiting for this card (sent to it, not acknowledged yet)
  const unreadMail = useBoard((s) => s.mail.filter((m) => m.to === id && !m.ackedAt).length)
  const select = useBoard((s) => s.select)

  // Spawn (or re-spawn) the process once the terminal knows its size.
  useEffect(() => {
    if (!handle) return
    if (launchedSeq.current === seq) return
    // a reloaded window's first launch of a card main still runs takes that process back (a Restart bumps launchSeq
    // and spawns as before); an asleep card has no process until it is woken (main wakes it, which bumps launchSeq)
    const first = launchedSeq.current === -1
    const mode = launchMode({ first, live: first && takeLive(id), asleep: data.asleep === true })
    if (mode === 'wait') return
    launchedSeq.current = seq
    const { term } = handle
    const api = window.ouroboros
    if (mode === 'attach') {
      void api.pty.attach(id).then((r) => {
        if (launchedSeq.current !== seq) return // restarted while this was asked: the restart's process is the card's
        if (!r.ok) {
          // it exited meanwhile, or main owes it a restart: launched as on a plain open. Removed or put to sleep meanwhile:
          // nothing to launch (main says which; the store may still hold a removed card until its pty.kill returns)
          if (r.launch) launch()
          return
        }
        // every chunk this terminal got before the reply is in the buffer: start clean and repaint from it. The reset is
        // RIS (ESC c) in the write queue, not term.reset(): a chunk still queued is parsed before it, not after it
        handle.replay('\x1bc' + (r.output ?? ''), () => {
          // the same size is no change to the PTY: a column less and back makes a full-screen CLI draw itself again
          api.pty.resize(id, term.cols - 1, term.rows)
          setTimeout(() => api.pty.resize(id, term.cols, term.rows), 120)
        })
      })
      return
    }
    launch()
    function launch(): void {
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
        void api.claude.launch({ nodeId: id, cwd, shell: data.shell, cols: term.cols, rows: term.rows, kind, engine: data.engine, claude: data.claude ?? {}, title: data.title, chatView: view === 'chat' }).then(report)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, seq, id, kind])

  // First instruction: typed once the session reports idle/ready, then removed from the card data.
  useEffect(() => {
    if (!data.initialPrompt || status !== 'idle') return
    const prompt = data.initialPrompt
    updateNodeData(id, { initialPrompt: undefined })
    // main forgets it now, before it is typed: a sync held back by a drag would let a reattached page type it again
    syncNow()
    setTimeout(() => typePrompt(id, prompt, 200), 1200)
  }, [data.initialPrompt, status, id, updateNodeData])

  const KindIcon = kindIcon(kind, data.engine)
  return (
    <div className={`agent-node kind-${kind} status-${status}${far ? ' far' : ''}${selected ? ' selected' : ''}`}>
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} lineStyle={{ borderColor: 'var(--ring)' }} handleStyle={{ background: 'var(--text)', width: 14, height: 14, borderRadius: 3 }} onResizeStart={() => setDragShield(true)} onResizeEnd={() => setDragShield(false)} />
      <Handle type="target" position={Position.Left} className="port port-in" />
      <Handle type="source" position={Position.Right} className="port port-out" />
      <div className="node-header">
        <StateGlyph status={status} />
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
            <KindIcon className="ico kind" size={13} aria-hidden="true" />
            <span>{data.title}</span>
          </span>
        )}
        <span className="status-text" title={asleep ? 'Asleep: its process is stopped; the conversation is kept and resumes on Wake or the next prompt' : [data.topic, detail].filter(Boolean).join('\n') || undefined}>
          {asleep ? 'Asleep' : STATUS_LABEL[status]}
          {!asleep && detail ? ` · ${detail}` : ''}
        </span>
        <span className="spacer" />
        {unreadMail > 0 && (
          <span className="mail-badge" title={`${unreadMail} board message(s) for this card not acknowledged yet (Inspector → Mail)`}>
            ✉ {unreadMail}
          </span>
        )}
        {subagents && subagents.length > 0 && (
          <button
            className="sub-badge nodrag"
            title={[`${subagents.length} subagent${subagents.length === 1 ? '' : 's'} running — click for the list in the Inspector`, ...subagents.slice(0, 12).map((r) => `${r.type}${r.description ? `: ${r.description}` : ''} (${elapsedText(Date.now() - r.startedAt)})`), ...(subagents.length > 12 ? [`… ${subagents.length - 12} more`] : [])].join('\n')}
            onClick={() => select(id, null)}
          >
            <span className="sub-dot" aria-hidden="true" /> {subagents.length}
          </button>
        )}
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
          <button className="icon-btn nodrag" title={`Open the latest brief in the Briefs card\n${data.lastBriefUrl}`} aria-label="Open the latest brief" onClick={() => void window.ouroboros.brief.open(data.lastBriefUrl as string, id)}>
            <Icon name="brief" size={14} />
          </button>
        )}
        {changes && changes.repo && changes.files.length > 0 && (
          <button className="changes-badge nodrag" title={`${changes.files.length} changed file(s) on ${changes.branch ?? '?'} — click to review in the Inspector`} onClick={() => select(id, null)}>
            <span className="add">+{changes.added}</span> <span className="del">−{changes.deleted}</span>
          </button>
        )}
        {chatCapable(data) && (
          <button
            className={`icon-btn nodrag${chat ? ' active' : ''}`}
            title={chat ? 'Chat view: click for the terminal (the same session)' : 'Terminal: click for the chat view (the same session, replies as markdown with diagrams)'}
            aria-label={chat ? 'Show the terminal' : 'Show the chat view'}
            aria-pressed={chat}
            onClick={() => {
              setPeek(false)
              updateNodeData(id, { view: chat ? 'terminal' : 'chat' })
              if (chat) setTimeout(() => handle?.term.focus(), 0)
            }}
          >
            <Icon name={chat ? 'terminal' : 'chat'} size={14} />
          </button>
        )}
        {asleep ? (
          <button className="btn small nodrag" title="Wake: start it again on the same conversation" onClick={() => void window.ouroboros.board.wake(id)}>
            <Icon name="play" size={12} /> Wake
          </button>
        ) : (
          <button className="icon-btn nodrag" title="Restart" aria-label="Restart" onClick={() => void restartNode(id)}>
            <Icon name="refresh" size={14} />
          </button>
        )}
        <button className="icon-btn nodrag" title="Close" aria-label="Close card" onClick={() => void removeNode(id)}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="scale-wrap">
        {/* sized and scaled by useTerminal (render scale), not by React: a re-render must not undo it */}
        <div className="terminal-host nodrag nowheel" ref={ref} onMouseDown={() => handle?.term.focus()} />
        {(view === 'chat' || chatMounted) && chatCapable(data) && (
          <ChatView
            id={id}
            data={data}
            status={status}
            hidden={!chat}
            onShowTerminal={() => {
              setPeek(true)
              setTimeout(() => handle?.term.focus(), 0)
            }}
          />
        )}
        {asleep && !far && (
          <div className="card-asleep nodrag">
            <Icon name="moon" size={22} aria-hidden="true" />
            <div>Asleep: its process is stopped to save memory. The conversation is kept.</div>
            <div className="muted small">Wake it, or send it a prompt or a message: it resumes the same conversation.</div>
            <button className="btn" onClick={() => void window.ouroboros.board.wake(id)}>
              <Icon name="play" size={12} /> Wake
            </button>
          </div>
        )}
        {far && (
          <div className="card-summary">
            <div className="summary-title">{data.title}</div>
            {data.topic && <div className="summary-topic">{data.topic}</div>}
            <div className="summary-status">
              <StateGlyph status={status} size={22} />
              <span>
                {asleep ? 'Asleep' : STATUS_LABEL[status]}
                {!asleep && detail ? ` · ${detail}` : ''}
              </span>
            </div>
            {summary && <div className="summary-text">{summary}</div>}
          </div>
        )}
        {!far && !chat && scrolledUp && (
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
