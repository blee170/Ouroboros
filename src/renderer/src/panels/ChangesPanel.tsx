import { useEffect, useState } from 'react'
import type { ChangesSummary } from '@shared/protocol'
import { typePrompt } from '@/lib/typePrompt'

/** Uncommitted changes of a card's folder: file list, per-file diff, revert, and "ask the card to review". */
export function ChangesPanel({ nodeId, cwd }: { nodeId: string; cwd: string }) {
  const [summary, setSummary] = useState<ChangesSummary | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [open, setOpen] = useState(true)
  const load = async (): Promise<void> => {
    try {
      setSummary(await window.ouroboros.changes.summary(cwd))
    } catch {
      setSummary(null)
    }
  }
  useEffect(() => {
    setFile(null)
    setDiff('')
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])
  useEffect(() => {
    if (!file) return
    void window.ouroboros.changes.diff(cwd, file).then(setDiff).catch(() => setDiff(''))
  }, [cwd, file])
  if (!summary || !summary.repo) return null
  const revert = async (path: string): Promise<void> => {
    if (!confirm(`Discard changes to ${path}? (tracked: restore from HEAD; untracked: delete)`)) return
    const r = await window.ouroboros.changes.revert(cwd, path)
    if (!r.ok) alert(r.error)
    setFile(null)
    await load()
  }
  const askReview = (): void => {
    const text = 'Review your uncommitted changes (git diff) against the task: list what changed and why, point out anything risky or unfinished, then fix what you find and end with RESULT: and ISSUES: lines.'
    typePrompt(nodeId, text)
  }
  return (
    <div className="changes">
      <div className="row between">
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Changes {summary.branch ? `on ${summary.branch}` : ''} · <span className="add">+{summary.added}</span> <span className="del">−{summary.deleted}</span> · {summary.files.length} file{summary.files.length === 1 ? '' : 's'}
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => void load()}>
          ↻
        </button>
      </div>
      {open && summary.files.length === 0 && <div className="muted small">Working tree clean.</div>}
      {open && summary.files.length > 0 && (
        <>
          <ul className="change-list">
            {summary.files.map((f) => (
              <li key={f.path} className={file === f.path ? 'active' : ''}>
                <button className="change-file" title={f.path} onClick={() => setFile(file === f.path ? null : f.path)}>
                  <span className={`st st-${f.status}`}>{f.status}</span>
                  <span className="path">{f.path}</span>
                  <span className="add">+{f.added}</span>
                  <span className="del">−{f.deleted}</span>
                </button>
                <button className="icon-btn" title="Discard this file's changes" onClick={() => void revert(f.path)}>
                  ⎌
                </button>
              </li>
            ))}
          </ul>
          {file && (
            <pre className="diff">
              {diff.split('\n').map((l, i) => (
                <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'dl-add' : l.startsWith('-') && !l.startsWith('---') ? 'dl-del' : l.startsWith('@@') ? 'dl-hunk' : ''}>
                  {l}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
          <div className="row">
            <button className="btn" onClick={askReview} title="Type a review request into this card">
              🔍 Ask card to review its diff
            </button>
          </div>
        </>
      )}
    </div>
  )
}
