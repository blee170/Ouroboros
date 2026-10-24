/**
 * Zoom math for terminal cards (pure; the DOM side is src/renderer/src/lib/terminalScale.ts).
 *
 * The canvas zooms with a CSS transform, which would blur xterm's bitmap. So the terminal host is
 * counter-scaled to screen pixels and drawn with a font scaled by the same factor (the "render scale").
 * The grid (cols × rows), and with it the PTY size, depends only on the card's size: zooming changes the
 * font, never the grid, so the CLI inside is not resized and does not redraw itself on every zoom step.
 */
export const BASE_FONT_SIZE = 13
/** Below this zoom a card shows a readable summary instead of the (unreadably small) terminal. */
export const FAR_ZOOM = 0.55
/** Above this zoom the terminal is magnified instead of drawn larger (keeps the glyph atlas small). */
export const MAX_RENDER_SCALE = 2.5

export function renderScale(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.min(MAX_RENDER_SCALE, Math.max(FAR_ZOOM, zoom))
}

/** Font size for a render scale, rounded down so the grid never outgrows its host. */
export function fontFor(scale: number): number {
  return Math.floor(BASE_FONT_SIZE * scale * 10) / 10
}

/** The part of an xterm buffer `tailText` reads. */
export interface BufferLike {
  buffer: { active: { length: number; getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined } }
}

/** The last non-empty lines of a terminal's buffer, for the zoomed-out summary. */
export function tailText(term: BufferLike, lines: number): string {
  const b = term.buffer.active
  const out: string[] = []
  for (let y = b.length - 1; y >= 0 && out.length < lines; y--) {
    const text = b.getLine(y)?.translateToString(true).trim() ?? ''
    if (text) out.unshift(text)
  }
  return out.join('\n')
}
