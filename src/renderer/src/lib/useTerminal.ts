import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'

export interface TerminalHandle {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
}

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
      fontSize: 13,
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
    const h: TerminalHandle = { term, fit, search }
    handleRef.current = h
    setHandle(h)
    return () => {
      ro.disconnect()
      offData()
      inputSub.dispose()
      term.dispose()
      handleRef.current = null
      setHandle(null)
    }
  }, [nodeId, containerRef])

  return handle
}
