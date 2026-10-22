import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'

export interface TerminalHandle {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** Scale the font with the canvas zoom (the DOM itself is kept unscaled so mouse mapping stays exact). */
  setZoom(zoom: number): void
}

export const BASE_FONT_SIZE = 13

/**
 * Mounts an xterm.js terminal into `containerRef`, pipes it to the PTY of `nodeId`
 * and keeps the PTY size in sync with the DOM size. Returns the handle once ready.
 */
export function useTerminal(nodeId: string, containerRef: React.RefObject<HTMLDivElement | null>): TerminalHandle | null {
  const [handle, setHandle] = useState<TerminalHandle | null>(null)
  const handleRef = useRef<TerminalHandle | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: BASE_FONT_SIZE,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      scrollback: 8000,
      theme: {
        background: '#0b0d13',
        foreground: '#d6d9e0',
        cursor: '#38bdf8',
        selectionBackground: '#334155',
        black: '#1e2230', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb',
        brightBlack: '#475569', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f8fafc'
      }
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    // the CLIs lay out emoji as 2 columns (Unicode 11 widths); xterm's built-in table is Unicode 6, which
    // drifts the cursor and box borders on every ✅ 📄 in a reply
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(el)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* DOM renderer fallback */
    }
    const api = window.ouroboros
    const offData = api.pty.onData((id, data) => {
      if (id === nodeId) term.write(data)
    })
    const inputSub = term.onData((d) => api.pty.write(nodeId, d))
    // Screenshots pasted or files dropped onto the card are saved/resolved and their path typed into
    // the prompt (Claude Code reads image paths), so feedback screenshots can be handed to an agent.
    const quote = (p: string): string => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)
    const typePaths = (paths: string[]): void => {
      if (paths.length) api.pty.write(nodeId, paths.map(quote).join(' ') + ' ')
    }
    // Ctrl+V: xterm would turn it into ^V for the CLI and the browser would never fire a paste event,
    // so the clipboard is read through the main process (an image becomes a file path, text is pasted)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true
      // Ctrl+C with a selection copies it; without one it stays the interrupt the CLI expects
      if (e.key.toLowerCase() === 'c' && term.hasSelection()) {
        e.preventDefault()
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }
      if (e.key.toLowerCase() !== 'v') return true
      e.preventDefault()
      void api.files.pasteClipboard().then((r) => {
        if (r.path) typePaths([r.path])
        else if (r.text) term.paste(r.text)
      })
      return false
    })
    const onPaste = (e: ClipboardEvent): void => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (!files.length) return
      e.preventDefault()
      e.stopPropagation()
      void Promise.all(files.map(async (f) => api.files.saveImage(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1] || 'png'))).then(typePaths)
    }
    const onDrop = (e: DragEvent): void => {
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!files.length) return
      e.preventDefault()
      e.stopPropagation()
      typePaths(files.map((f) => api.files.pathFor(f)).filter(Boolean))
      term.focus()
    }
    const onDragOver = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    el.addEventListener('paste', onPaste, true)
    el.addEventListener('drop', onDrop)
    el.addEventListener('dragover', onDragOver)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      try {
        fit.fit()
        api.pty.resize(nodeId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
    }
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doFit, 60)
    })
    ro.observe(el)
    doFit()
    const setZoom = (zoom: number): void => {
      const size = Math.max(6, Math.round(BASE_FONT_SIZE * zoom * 10) / 10)
      if (term.options.fontSize === size) return
      term.options.fontSize = size
      requestAnimationFrame(doFit)
    }
    const h: TerminalHandle = { term, fit, search, setZoom }
    handleRef.current = h
    setHandle(h)
    return () => {
      ro.disconnect()
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('dragover', onDragOver)
      offData()
      inputSub.dispose()
      term.dispose()
      handleRef.current = null
      setHandle(null)
    }
  }, [nodeId, containerRef])

  return handle
}
