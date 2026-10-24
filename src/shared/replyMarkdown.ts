import { Marked, type Tokens } from 'marked'

/**
 * A card's reply, rendered: GitHub-flavoured markdown (tables, code, lists) with every file or folder path
 * turned into `<a class="path" data-path="…">` so the owner can open what the agent wrote about with a
 * click. Pure (no DOM): the renderer sanitises the result, tests run it in node.
 */

/** A run that may be a path: letters, digits, the characters paths use, both slashes and the drive colon. */
const CANDIDATE = /[\p{L}\p{N}_.@~%+()\\/:-]+/gu
const DOMAIN_TAIL = /\.(ai|com|net|org|io|co|kr|dev|app|info|me|us|uk|jp|cn|de|fr|xyz|cloud|sh|gg|tv)$/i

/** Trailing sentence punctuation is not part of the path; a trailing slash is. */
function trimPath(s: string): string {
  let out = s.replace(/[.,;:)]+$/, '')
  // a path written in parentheses keeps its closing one only if it opened inside
  while (out.endsWith(')') && (out.match(/\(/g) ?? []).length < (out.match(/\)/g) ?? []).length) out = out.slice(0, -1)
  return out
}

/**
 * Is this run a path worth linking? Absolute (drive, `~/`, `./`, `../`) always; a bare relative one needs
 * two segments and some sign it is not prose (`and/or`, `TCP/IP`): an extension, a dash or underscore,
 * three segments, or a trailing slash. URLs and bare numbers (dates) never.
 */
export function looksLikePath(s: string): boolean {
  // a bare file name with an extension (CARD.md, package.json) resolves against the card's folder; domains do not count
  if (!/[\\/]/.test(s)) return /^\.?[\p{L}\p{N}_@()%+-]{2,}(\.[\p{L}\p{N}_-]+)*\.[a-z0-9]{1,6}$/iu.test(s) && !DOMAIN_TAIL.test(s)
  if (s.includes('://') || !/\p{L}/u.test(s)) return false
  if (/^([A-Za-z]:|~|\.{1,2})[\\/]/.test(s)) return s.length > 3
  if (/^[\\/]/.test(s)) return false // a bare "/foo" on Windows is more often prose than a path
  const segs = s.split(/[\\/]/)
  if (segs.length < 2 || segs.some((x, i) => x === '' && i !== segs.length - 1)) return false
  if (segs.length >= 3 || s.endsWith('/') || s.endsWith('\\')) return true
  return /[-_.]/.test(segs[segs.length - 1]) || /[-_.]/.test(segs[0])
}

/** Wrap the paths in an HTML-escaped text run. Entities (`&amp;`) never match: `&` and `;` are not path characters. */
export function linkifyPaths(escaped: string): string {
  return escaped.replace(CANDIDATE, (run, offset: number, whole: string) => {
    const before = whole[offset - 1]
    if (before && /[\p{L}\p{N}/\\.]/u.test(before)) return run // the tail of a word or a URL
    const p = trimPath(run)
    if (!looksLikePath(p)) return run
    return `<a class="path" data-path="${p}" title="Open ${p}">${p}</a>${run.slice(p.length)}`
  })
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    codespan({ text }: Tokens.Codespan): string {
      // the token text is raw: escape it here (the default renderer does), then link
      return `<code>${linkifyPaths(escapeHtml(text))}</code>`
    },
    text(token: Tokens.Text | Tokens.Escape): string {
      if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens)
      return linkifyPaths('escaped' in token && token.escaped ? token.text : escapeHtml(token.text))
    },
    // raw HTML in a reply is shown as text (DOMPurify in the renderer is the second wall)
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text)
    }
  }
})

/** Markdown → HTML (unsanitised: the renderer runs DOMPurify over it before it touches the DOM). */
export function renderReply(markdown: string): string {
  return md.parse(markdown, { async: false }) as string
}
