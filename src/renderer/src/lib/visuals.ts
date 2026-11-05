import DOMPurify from 'dompurify'
import { MERMAID_LOCKED, cssLoadsNothing, localRef, plainMermaid } from '@shared/visuals'

/**
 * Diagrams in a reply (chat view). Both kinds end as SVG mounted in the card, and both come from model output,
 * so both go through one wall: no scripts or handlers, no HTML inside the SVG, no links, no images, and nothing
 * that makes the window fetch: a reference may only point inside the drawing (`#id`, `url(#id)`). Behind it: the
 * page's CSP (scripts from the app only; no http(s) image) and, for file: URLs on another machine, which the CSP
 * lets through, the request block in main (index.ts, remoteFileUrl). Mermaid draws in the live page before this
 * wall sees its output, so those two are what stops a load during drawing.
 */

// an instance of its own: the hooks below must not run for the markdown sanitiser
const purify = DOMPurify(window)
let allowCss = false
purify.addHook('uponSanitizeElement', (node, data) => {
  // a stylesheet inside the drawing (Mermaid's own): kept only when it is text alone (a child element would make
  // the text checked here differ from the text the browser applies) and loads nothing
  if (data.tagName === 'style' && !(allowCss && (node as Element).childElementCount === 0 && cssLoadsNothing(node.textContent ?? ''))) node.parentNode?.removeChild(node)
})
purify.addHook('uponSanitizeAttribute', (_node, data) => {
  const name = data.attrName.toLowerCase()
  if (name === 'href' || name === 'xlink:href') data.keepAttr = localRef(data.attrValue)
  else if (name === 'style') data.keepAttr = allowCss && cssLoadsNothing(data.attrValue)
  else if (!cssLoadsNothing(data.attrValue)) data.keepAttr = false
})

/** SVG text safe to mount, or null when nothing drawable is left. `css`: keep style attributes and stylesheets that load nothing (Mermaid's output needs them). */
export function safeSvg(svg: string, css = false): string | null {
  allowCss = css
  try {
    const out = purify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject', 'image', 'feImage', 'a', 'animate', 'set', 'animateTransform', 'animateMotion'],
      ALLOW_DATA_ATTR: false
    })
    return /^\s*<svg[\s>]/i.test(out) ? out : null
  } finally {
    allowCss = false
  }
}

type Mermaid = (typeof import('mermaid'))['default']
let loading: Promise<Mermaid> | undefined
// one drawing at a time: Mermaid measures text in a scratch element it adds to the page
let queue: Promise<unknown> = Promise.resolve()
let seq = 0
const DRAW_TIMEOUT_MS = 15_000

function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then(
    ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        // strict: no click handlers, labels sanitised; plain SVG text labels, so there is no HTML inside the drawing
        securityLevel: 'strict',
        htmlLabels: false,
        theme: 'dark',
        fontFamily: 'inherit',
        suppressErrorRendering: true,
        // a diagram cannot switch these for itself with %%{init}%% or front matter
        secure: [...MERMAID_LOCKED]
      })
      return mermaid
    },
    (err: unknown) => {
      loading = undefined // a failed load is tried again with the next diagram
      throw err
    }
  )
  return loading
}

/** Draw Mermaid source. Never throws: a diagram that does not parse comes back as the reason, and the caller shows the source. */
export function drawMermaid(code: string): Promise<{ ok: true; svg: string } | { ok: false; error: string }> {
  const run = async (): Promise<{ ok: true; svg: string } | { ok: false; error: string }> => {
    const id = `ouro-mermaid-${++seq}`
    try {
      const mermaid = await loadMermaid()
      // a drawing that never settles must not hold every later one
      const { svg } = await Promise.race([mermaid.render(id, plainMermaid(code)), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('drawing took too long')), DRAW_TIMEOUT_MS))])
      const safe = safeSvg(svg, true)
      return safe ? { ok: true, svg: safe } : { ok: false, error: 'the drawing was empty after cleaning' }
    } catch (err) {
      return { ok: false, error: (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200) }
    } finally {
      // Mermaid leaves its scratch element behind when a diagram fails
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  }
  const next = queue.then(run, run)
  queue = next
  return next
}
