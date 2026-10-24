import { useEffect, useMemo, useState } from 'react'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { copyText, markdownHtml, onMarkdownClick } from '@/lib/markdown'

/**
 * A card's last reply as the agent meant it: tables, code, lists, with file paths that open on click,
 * a Copy button for the raw text and "Pop out", which puts the reply on the canvas as a note so a long
 * run-book can sit beside the cards it talks about.
 */
export function ReplyView({ text, cwd, title }: { text: string; cwd?: string; title: string }) {
  const addNode = useBoard((s) => s.addNode)
  const html = useMemo(() => markdownHtml(text), [text])
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])
  return (
    <div className="reply">
      <div className="reply-actions">
        <button className="btn small" onClick={() => void copyText(text).then((ok) => setNote(ok ? 'Copied' : 'Copy failed'))} title="Copy the reply as text">
          <Icon name="copy" size={14} /> Copy
        </button>
        <button className="btn small" onClick={() => addNode('note', { title: `${title} · reply`, note: text, cwd })} title="Put this reply on the canvas as a note card (its paths open relative to this card's folder)">
          <Icon name="external" size={14} /> Pop out
        </button>
        {note && <span className="muted small">{note}</span>}
      </div>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} onClick={(e) => void onMarkdownClick(e, cwd).then((m) => m && setNote(m), (err: Error) => setNote(err.message))} />
    </div>
  )
}
