import DOMPurify from 'dompurify'
import type { MouseEvent } from 'react'
import { renderReply } from '@shared/replyMarkdown'

/**
 * Reply or note markdown → HTML safe to mount. The renderer already escapes raw HTML; DOMPurify is the
 * second wall: no scripts or handlers, no `style` (an invisible full-window anchor), only `data-path`
 * among data attributes, and only http(s)/mailto URLs: a relative or `//host` image on a file:// page
 * would be fetched over SMB and leak the owner's credentials before anything is clicked.
 */
export function markdownHtml(text: string): string {
  return DOMPurify.sanitize(renderReply(text), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['data-path'],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i
  })
}

/**
 * Click handler for rendered markdown: a `.path` link asks main to open the file or folder (main decides
 * whether it is opened or only revealed), an http(s) link goes to the system browser, anything else is
 * inert. Returns a line for the owner when a path cannot be opened.
 */
export async function onMarkdownClick(e: MouseEvent<HTMLElement>, cwd: string | undefined): Promise<string | null> {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return null
  e.preventDefault()
  const p = a.dataset.path
  if (p) {
    try {
      const r = await window.ouroboros.shell.openPath(p, cwd)
      if (!r.ok) return `${r.error}: ${r.path}`
      return r.revealed ? `Shown in its folder (not opened): ${r.path}` : null
    } catch (err) {
      return `Could not open: ${(err as Error).message}`
    }
  }
  const href = a.getAttribute('href') ?? ''
  if (/^https?:\/\//.test(href)) void window.ouroboros.shell.openExternal(href)
  return null
}

/** Copy text from the renderer; `navigator.clipboard` is missing on some origins, the old command is not. Resolves to whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* fall through */
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  return ok
}
