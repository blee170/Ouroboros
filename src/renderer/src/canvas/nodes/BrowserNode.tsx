import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { NodeResizer, useStore, type NodeProps } from '@xyflow/react'
import type { BoardNode } from '@/store/board'
import { useBoard } from '@/store/board'
import { setDragShield } from '@/lib/dragShield'

/** Minimal surface of Electron's <webview> element that we use. */
interface WebviewEl extends HTMLElement {
  getWebContentsId(): number
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  setZoomFactor(factor: number): void
}

// Google and some sites refuse sign-in from a UA that mentions Electron; present a plain Chrome UA.
const CHROME_UA = navigator.userAgent.replace(/\s?Electron\/[\d.]+/, '').replace(/\s?ouroboros\/[\d.]+/i, '')

function normalise(url: string): string {
  const u = url.trim()
  if (!u) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u
  if (/\s/.test(u) || !u.includes('.')) return `https://www.google.com/search?q=${encodeURIComponent(u)}`
  return `https://${u}`
}

function BrowserNodeImpl({ id, data, selected }: NodeProps<BoardNode>) {
  const ref = useRef<WebviewEl | null>(null)
  const updateNodeData = useBoard((s) => s.updateNodeData)
  const removeNode = useBoard((s) => s.removeNode)
  const [address, setAddress] = useState(data.url ?? 'https://www.google.com')
  // the webview's src is set once: every navigation writes the new URL into data.url, and re-setting
  // src to the page the webview is already on makes Electron load it a second time
  const [initialSrc] = useState(data.url ?? 'https://www.google.com')
  const [ready, setReady] = useState(false)
  const [pageTitle, setPageTitle] = useState('')
  const [bmOpen, setBmOpen] = useState(false)
  const [bmQuery, setBmQuery] = useState('')
  const [bookmarks, setBookmarks] = useState<Array<{ folder: string; title: string; url: string }> | null>(null)
  const openBookmarks = async (): Promise<void> => {
    if (!bookmarks) setBookmarks(await window.ouroboros.bookmarks.list())
    setBmOpen((v) => !v)
  }
  const visibleBookmarks = useMemo(() => {
    const q = bmQuery.trim().toLowerCase()
    const list = bookmarks ?? []
    return (q ? list.filter((b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q) || b.folder.toLowerCase().includes(q)) : list).slice(0, 300)
  }, [bookmarks, bmQuery])
  const zoom = useStore((s) => s.transform[2])
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => {
      try {
        ref.current?.setZoomFactor(zoom)
      } catch {
        /* not ready */
      }
    }, 80)
    return () => clearTimeout(t)
  }, [zoom, ready])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const api = window.ouroboros
    const onReady = (): void => {
      setReady(true)
      api.browser.register(id, el.getWebContentsId())
    }
    const onNav = (): void => {
      const u = el.getURL()
      setAddress(u)
      updateNodeData(id, { url: u })
    }
    const onTitle = (e: Event): void => setPageTitle((e as unknown as { title: string }).title ?? '')
    el.addEventListener('dom-ready', onReady)
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('page-title-updated', onTitle)
    return () => {
      el.removeEventListener('dom-ready', onReady)
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-navigate-in-page', onNav)
      el.removeEventListener('page-title-updated', onTitle)
      api.browser.unregister(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const resizeNode = useBoard((s) => s.resizeNode)
  const SIZES: Array<[number, number]> = [
    [640, 480],
    [960, 720],
    [1280, 900],
    [1600, 1100]
  ]
  const cycleSize = (): void => {
    const node = useBoard.getState().nodes.find((n) => n.id === id)
    const w = node?.measured?.width ?? node?.width ?? 640
    const idx = SIZES.findIndex(([sw]) => sw > w + 20)
    const [nw, nh] = SIZES[idx === -1 ? 0 : idx]
    resizeNode(id, nw, nh)
  }
  const go = (): void => {
    const u = normalise(address)
    setAddress(u)
    ref.current?.loadURL(u).catch(() => undefined)
  }

  return (
    <div className={`browser-node${selected ? ' selected' : ''}`}>
      <NodeResizer
        minWidth={360}
        minHeight={240}
        isVisible={selected}
        lineStyle={{ borderColor: 'var(--accent)' }}
        handleStyle={{ background: 'var(--accent)', width: 14, height: 14, borderRadius: 3 }}
        onResizeStart={() => setDragShield(true)}
        onResizeEnd={() => setDragShield(false)}
      />
      <div className="node-header">
        <span className="title" title={pageTitle}>
          🌐 {data.title}
        </span>
        <button className="icon-btn nodrag" title="Back" onClick={() => ref.current?.goBack()}>
          ‹
        </button>
        <button className="icon-btn nodrag" title="Forward" onClick={() => ref.current?.goForward()}>
          ›
        </button>
        <button className="icon-btn nodrag" title="Reload" onClick={() => ref.current?.reload()}>
          ↻
        </button>
        <button className="icon-btn nodrag" title="Chrome / Edge bookmarks" onClick={() => void openBookmarks()}>
          ★
        </button>
        <button className="icon-btn nodrag" title="Cycle size: 640×480 → 960×720 → 1280×900 → 1600×1100 (or drag any edge or corner)" onClick={() => cycleSize()}>
          ⤢
        </button>
        <button className="icon-btn nodrag" title="Open this page in your system browser (sites that refuse embedded sign-in)" onClick={() => void window.ouroboros.shell.openExternal(ref.current?.getURL() || address)}>
          ↗
        </button>
        <input
          className="address nodrag"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
          placeholder="URL or search"
        />
        <span className="status-text" title={pageTitle}>
          {ready ? pageTitle : 'loading…'}
        </span>
        <button className="icon-btn nodrag" title="Close" onClick={() => void removeNode(id)}>
          ✕
        </button>
      </div>
      {bmOpen && (
        <div className="bookmarks nodrag nowheel">
          <input className="text" autoFocus placeholder="search bookmarks…" value={bmQuery} onChange={(e) => setBmQuery(e.target.value)} />
          <ul>
            {visibleBookmarks.map((b) => (
              <li key={b.url}>
                <button
                  onClick={() => {
                    setAddress(b.url)
                    ref.current?.loadURL(b.url).catch(() => undefined)
                    setBmOpen(false)
                  }}
                  title={b.url}
                >
                  <span className="title">{b.title}</span>
                  <span className="muted small">{b.folder}</span>
                </button>
              </li>
            ))}
            {bookmarks && bookmarks.length === 0 && <li className="muted small">No Chrome/Edge bookmarks found on this machine.</li>}
          </ul>
        </div>
      )}
      <div className="scale-wrap">
      <div className="browser-host nodrag nowheel" style={{ transform: `scale(${1 / zoom})`, width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>
        <webview ref={ref as React.Ref<HTMLElement>} src={initialSrc} partition="persist:ouroboros-browser" allowpopups useragent={CHROME_UA} style={{ width: '100%', height: '100%' }} />
      </div>
      </div>
    </div>
  )
}

export const BrowserNode = memo(BrowserNodeImpl)
