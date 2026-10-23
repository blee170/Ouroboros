import DOMPurify from 'dompurify'
import type { MouseEvent } from 'react'
import { isExecutablePath, renderReply } from '@shared/replyMarkdown'

/** Reply or note markdown → HTML safe to mount: scripts, handlers and foreign protocols stripped. */
export function markdownHtml(text: string): string {
  return DOMPurify.sanitize(renderReply(text), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'] })
}

/**
 * Click handler for rendered markdown: a `.path` link opens the file or folder (relative to the card's
 * folder; executables are revealed, not run), an http(s) link goes to the system browser, anything else is
 * inert. Returns a line for the owner when a path cannot be opened.
 */
export async function onMarkdownClick(e: MouseEvent<HTMLElement>, cwd: string | undefined): Promise<string | null> {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return null
  e.preventDefault()
  const p = a.dataset.path
  if (p) {
    const r = await window.ouroboros.shell.openPath(p, cwd, isExecutablePath(p))
    return r.ok ? null : `${r.error}: ${r.path}`
  }
  const href = a.getAttribute('href') ?? ''
  if (/^https?:\/\//.test(href)) void window.ouroboros.shell.openExternal(href)
  return null
}

/** Copy text from the renderer; `navigator.clipboard` is missing on some origins, the old command is not. */
export function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
    return
  }
  fallbackCopy(text)
}

function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}
