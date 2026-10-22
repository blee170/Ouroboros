import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { fontFor } from '@shared/terminal-scale'

export { BASE_FONT_SIZE, FAR_ZOOM, MAX_RENDER_SCALE, fontFor, renderScale, tailText } from '@shared/terminal-scale'

/** Size the host for `scale`: laid out `scale` times the card, shown at 1/`scale`. */
export function styleHost(el: HTMLElement, scale: number): void {
  el.style.transform = `scale(${1 / scale})`
  el.style.width = `${scale * 100}%`
  el.style.height = `${scale * 100}%`
}

export function isAtBottom(term: Terminal): boolean {
  const b = term.buffer.active
  return b.viewportY >= b.baseY
}

/**
 * Draw the terminal at `scale` without touching its grid. Glyph cells are rounded to device pixels, so a
 * scaled font can come out a little larger than proportional and push the last row (the prompt) out of
 * view: the font is stepped down until the current grid fits. A view that was at the bottom stays there.
 */
export function applyScale(term: Terminal, fit: FitAddon, el: HTMLElement, scale: number): void {
  const bottom = isAtBottom(term)
  styleHost(el, scale)
  let size = fontFor(scale)
  term.options.fontSize = size
  for (let i = 0; i < 12; i++) {
    const p = fit.proposeDimensions()
    if (!p || (p.cols >= term.cols && p.rows >= term.rows)) break
    size = Math.round((size - 0.2) * 10) / 10
    if (size < 4) break
    term.options.fontSize = size
  }
  if (bottom) term.scrollToBottom()
}
