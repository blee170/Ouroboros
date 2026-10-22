/**
 * <webview> is an out-of-process surface: mouse events over it never reach our document, so a
 * resize or drag that crosses a browser card stops dead. While a drag is in progress we make every
 * webview ignore pointer events (CSS), which lets the gesture continue over them.
 */
export function setDragShield(on: boolean): void {
  document.body.classList.toggle('ouro-dragging', on)
}
