import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CHAT_LIMITS, composerBlock, confirmPending, pendingTool, splitReply, toolLabel, type ChatItem } from '@shared/chat'
import { toPastePayload } from '@shared/handoff'
import { STATUS_LABEL } from '@shared/status'
import { shownDetail } from '@shared/doing'
import type { AgentStatus, NodeData } from '@shared/types'
import { useChat } from '@/lib/useChat'
import { copyText, markdownHtml, onMarkdownClick } from '@/lib/markdown'
import { drawMermaid, safeSvg } from '@/lib/visuals'
import { StateGlyph } from '@/lib/StateGlyph'
import { Icon } from '@/lib/icons'

/** A prompt sent from this chat that the transcript has not shown yet. It leaves only when the transcript shows it, or the owner dismisses it. */
interface Pending {
  id: number
  text: string
  at: number
}

/**
 * A Claude card as a chat: its conversation (from the transcript) with replies as markdown, diagrams drawn, tool
 * calls folded, and a composer that types into the same session the terminal shows. The terminal stays mounted
 * underneath; a question the card asks (a permission prompt) is answered there, one click away.
 */
export function ChatView({ id, data, status, hidden, onShowTerminal }: { id: string; data: NodeData; status: AgentStatus; hidden: boolean; onShowTerminal: () => void }) {
  const chat = useChat(id, !hidden, status)
  const cwd = data.worktree?.path || data.cwd
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [now, setNow] = useState(() => Date.now())
  const pendingSeq = useRef(0)
  // when the card last stopped working: a prompt typed during a turn waits in Claude Code's own queue until then
  const idleSince = useRef(Date.now())
  useEffect(() => {
    if (status !== 'working') idleSince.current = Date.now()
  }, [status])

  // a prompt the transcript now shows is no longer pending (each transcript line answers for one prompt only)
  const confirmedBy = useRef<Set<string>>(new Set())
  useEffect(() => {
    setPending((cur) => {
      if (!cur.length) return cur
      const r = confirmPending(cur, chat.items, confirmedBy.current)
      confirmedBy.current = r.used
      return r.left.length === cur.length ? cur : r.left
    })
  }, [chat.items, pending.length])
  const statusNow = useRef(status)
  statusNow.current = status
  useEffect(() => {
    if (!pending.length) return
    const t = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(t)
  }, [pending.length])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(t)
  }, [notice])

  // stay on the latest line unless the owner scrolled up; a diagram drawn later changes the height too
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [away, setAway] = useState(false)
  const toBottom = (): void => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }
  useLayoutEffect(() => {
    if (stick.current) toBottom()
  }, [chat.items, pending, hidden, status])
  useEffect(() => {
    const el = inner.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setAway(!stick.current)
  }

  const block = composerBlock(status, undefined)
  const send = (): void => {
    const body = text.trim()
    if (!body) return
    // the text stays in the box when it cannot be sent: nothing the owner wrote is dropped
    if (block) return setNotice(block)
    // typed like the left composer does (bracketed paste, then Enter), except that the Enter is held back when the
    // card started asking a question in between: Enter there would pick the dialog's highlighted answer
    const api = window.ouroboros
    api.pty.write(id, toPastePayload(body))
    setTimeout(() => {
      if (statusNow.current === 'needs-you') return setNotice('The card started asking a question just as this was sent, so it was not submitted. Answer the question in the terminal; your text is in its input box.')
      api.pty.write(id, '\r')
    }, 150)
    setPending((cur) => [...cur, { id: ++pendingSeq.current, text: body, at: Date.now() }])
    setText('')
    stick.current = true
    setAway(false)
    // a slash command may open a menu that only the terminal shows (/model, /resume, /config): show it, so the next
    // thing typed is not taken as that menu's answer. The header button brings the chat back.
    if (body.startsWith('/')) {
      onShowTerminal()
      setNotice('Slash commands run in the terminal: it is shown in case the command opens a menu.')
    }
  }
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter breaks the line; an Enter that only confirms a Korean/Japanese composition does neither
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    send()
  }
  const asked = status === 'needs-you' ? pendingTool(chat.items) : undefined
  const detail = shownDetail(data)

  return (
    <div className="chat-view nodrag nowheel nopan" style={hidden ? { display: 'none' } : undefined}>
      <div className="chat-scroll" ref={scroller} onScroll={onScroll} onClick={(e) => void onMarkdownClick(e, cwd).then((m) => m && setNotice(m), (err: Error) => setNotice(err.message))}>
        <div className="chat-inner" ref={inner}>
          {chat.clipped && <div className="chat-note">Earlier turns of this long conversation are not shown here. They are in the terminal.</div>}
          {chat.loaded && !chat.items.length && !pending.length && !chat.error && <div className="chat-empty">No conversation yet. Write below to start, or switch to the terminal with the button in the card's header.</div>}
          {chat.items.map((item) => (
            <ChatRow key={item.id} item={item} onNote={setNotice} />
          ))}
          {pending.map((p) => {
            const waited = now - Math.max(p.at, idleSince.current)
            const late = status !== 'working' && waited > CHAT_LIMITS.pendingMs
            return (
              <div key={p.id} className={`chat-row user pending${late ? ' late' : ''}`}>
                <div className="chat-bubble">{p.text}</div>
                <div className="chat-pending-state">
                  {late ? 'Not seen in the conversation yet. Check the terminal: the card may be waiting on something else.' : status === 'working' ? 'Queued: the card takes it when its current step ends.' : 'Sending…'}
                  {late && (
                    <>
                      {' '}
                      <button className="link inline" onClick={onShowTerminal}>
                        Open the terminal
                      </button>{' '}
                      <button className="link inline" onClick={() => setPending((cur) => cur.filter((x) => x.id !== p.id))}>
                        Dismiss
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
          {status === 'working' && (
            <div className="chat-working">
              <StateGlyph status="working" size={12} decorative />
              <span>
                {STATUS_LABEL.working}
                {detail ? ` · ${detail}` : ''}
              </span>
            </div>
          )}
          {chat.error && <div className="chat-note error">{chat.error} The terminal still shows the session.</div>}
        </div>
      </div>
      {away && (
        <button
          className="jump-bottom chat-jump"
          title="Scroll to the latest message"
          onClick={() => {
            stick.current = true
            setAway(false)
            toBottom()
          }}
        >
          <Icon name="down" size={14} />
        </button>
      )}
      {status === 'needs-you' && (
        <div className="chat-needs" role="alert">
          <div className="chat-needs-text">
            <b>Needs you.</b> {data.statusDetail || 'The card is waiting on a question.'}
            {asked && (
              <code className="chat-needs-tool" title={asked.input}>
                {toolLabel(asked.name)}
                {asked.summary ? `: ${asked.summary}` : ''}
              </code>
            )}
          </div>
          <button className="btn small primary" onClick={onShowTerminal} title="Show this card's terminal to answer the question with the keyboard. The chat comes back when the card carries on.">
            Answer in the terminal
          </button>
        </div>
      )}
      {notice && (
        <div className="chat-notice" role="status">
          {notice}
        </div>
      )}
      <div className="chat-composer">
        <textarea
          className="text"
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          value={text}
          maxLength={CHAT_LIMITS.composerChars}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={block ? `${block.split('. ')[0].replace(/\.$/, '')}.` : 'Message this card (Enter sends, Shift+Enter for a new line)'}
          aria-label={`Message ${data.title}`}
        />
        {status === 'working' && (
          <button className="icon-btn" title="Interrupt the current turn (Esc in the terminal)" aria-label="Interrupt" onClick={() => window.ouroboros.pty.write(id, '\x1b')}>
            <Icon name="stop" size={14} />
          </button>
        )}
        <button className="icon-btn chat-send" disabled={!text.trim()} title={block ?? 'Send (Enter)'} aria-label="Send" onClick={send}>
          <Icon name="send" size={15} />
        </button>
      </div>
    </div>
  )
}

const ChatRow = memo(function ChatRow({ item, onNote }: { item: ChatItem; onNote: (m: string) => void }) {
  if (item.type === 'user')
    return (
      <div className="chat-row user">
        <div className="chat-bubble">{item.text}</div>
      </div>
    )
  if (item.type === 'note') return <div className="chat-note">{item.text}</div>
  if (item.type === 'thinking')
    return (
      <details className="chat-fold">
        <summary>
          <span className="chat-fold-name">Thinking</span>
        </summary>
        <pre>{item.text}</pre>
      </details>
    )
  if (item.type === 'tool') {
    const state = !item.result ? 'running' : item.result.error ? 'error' : 'done'
    return (
      <details className={`chat-fold tool ${state}`}>
        <summary title={state === 'running' ? 'No result yet' : state === 'error' ? 'The tool reported an error' : 'Done'}>
          <span className="chat-fold-dot" aria-hidden="true" />
          <span className="chat-fold-name">{toolLabel(item.name)}</span>
          {item.summary && <span className="chat-fold-summary">{item.summary}</span>}
          {state === 'error' && <span className="chat-fold-state">error</span>}
        </summary>
        <div className="chat-fold-label">Input</div>
        <pre>{item.input}</pre>
        {item.result && (
          <>
            <div className="chat-fold-label">{item.result.error ? 'Error' : 'Result'}</div>
            <pre>{item.result.text || '(empty)'}</pre>
          </>
        )}
      </details>
    )
  }
  return <Reply text={item.text} onNote={onNote} />
})

/** An assistant reply: markdown, with the diagrams it carries drawn in place. */
function Reply({ text, onNote }: { text: string; onNote: (m: string) => void }) {
  const parts = useMemo(() => splitReply(text), [text])
  return (
    <div className="chat-row assistant">
      <div className="chat-reply">
        {parts.map((p, i) => (p.type === 'md' ? <Markdown key={i} text={p.text} /> : p.type === 'svg' ? <SvgBlock key={i} code={p.code} /> : <MermaidBlock key={i} code={p.code} />))}
      </div>
      <button className="icon-btn chat-copy" title="Copy this reply as text" aria-label="Copy reply" onClick={() => void copyText(text).then((ok) => onNote(ok ? 'Copied' : 'Copy failed'))}>
        <Icon name="copy" size={13} />
      </button>
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => markdownHtml(text), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

/** A drawing that could not be shown is never dropped: its source is shown as code, with the reason. */
function VisualSource({ why, code }: { why: string; code: string }) {
  return (
    <div className="chat-visual failed">
      <div className="chat-visual-why">{why}</div>
      <pre>{code}</pre>
    </div>
  )
}

function SvgBlock({ code }: { code: string }) {
  const svg = useMemo(() => safeSvg(code), [code])
  if (!svg) return <VisualSource why="This drawing could not be shown (nothing was left after removing what a drawing may not contain). Its source:" code={code} />
  return <div className="chat-visual" dangerouslySetInnerHTML={{ __html: svg }} />
}

function MermaidBlock({ code }: { code: string }) {
  const [drawn, setDrawn] = useState<{ svg?: string; error?: string } | null>(null)
  useEffect(() => {
    let on = true
    setDrawn(null)
    void drawMermaid(code).then((r) => {
      if (on) setDrawn(r.ok ? { svg: r.svg } : { error: r.error })
    })
    return () => {
      on = false
    }
  }, [code])
  if (!drawn) return <div className="chat-visual drawing">Drawing the diagram…</div>
  if (!drawn.svg) return <VisualSource why={`This diagram could not be drawn (${drawn.error ?? 'unknown reason'}). Its source:`} code={code} />
  return (
    <div className="chat-visual">
      <div dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      <details className="chat-visual-source">
        <summary>Diagram source</summary>
        <pre>{code}</pre>
      </details>
    </div>
  )
}
