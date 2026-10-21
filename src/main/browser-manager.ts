import { webContents, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BrowserPage {
  url: string
  title: string
  text: string
  truncated: boolean
}

/**
 * Tracks the <webview> of every browser card (renderer registers its webContents id)
 * and exposes the few actions agents need. All page access goes through executeJavaScript
 * in the page's own context, so logins the user made in the card are reused.
 */
export class BrowserManager {
  private ids = new Map<string, number>()

  register(nodeId: string, wcId: number): void {
    this.ids.set(nodeId, wcId)
  }

  unregister(nodeId: string): void {
    this.ids.delete(nodeId)
  }

  has(nodeId: string): boolean {
    return this.get(nodeId) !== undefined
  }

  get(nodeId: string): WebContents | undefined {
    const id = this.ids.get(nodeId)
    if (id === undefined) return undefined
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) {
      this.ids.delete(nodeId)
      return undefined
    }
    return wc
  }

  private need(nodeId: string): WebContents {
    const wc = this.get(nodeId)
    if (!wc) throw new Error(`no browser card "${nodeId}" (or its page is not ready yet)`)
    return wc
  }

  async navigate(nodeId: string, url: string): Promise<{ url: string }> {
    const wc = this.need(nodeId)
    const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
    try {
      await wc.loadURL(target)
    } catch (e) {
      // ERR_ABORTED is common for redirects; report the final URL instead of failing
      if (!/ERR_ABORTED/.test(String((e as Error).message))) throw e
    }
    return { url: wc.getURL() }
  }

  async read(nodeId: string, maxChars = 20_000): Promise<BrowserPage> {
    const wc = this.need(nodeId)
    const r = (await wc.executeJavaScript(
      `(() => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '') }))()`,
      true
    )) as { url: string; title: string; text: string }
    const text = (r.text ?? '').replace(/\n{3,}/g, '\n\n')
    return { url: r.url, title: r.title, text: text.slice(0, maxChars), truncated: text.length > maxChars }
  }

  async links(nodeId: string, limit = 100): Promise<Array<{ text: string; href: string }>> {
    const wc = this.need(nodeId)
    return (await wc.executeJavaScript(
      `(() => Array.from(document.querySelectorAll('a[href]')).slice(0, ${limit | 0}).map(a => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 120), href: a.href })))()`,
      true
    )) as Array<{ text: string; href: string }>
  }

  async click(nodeId: string, target: { selector?: string; text?: string }): Promise<{ ok: boolean; matched?: string }> {
    const wc = this.need(nodeId)
    const script = `(() => {
      const sel = ${JSON.stringify(target.selector ?? '')};
      const txt = ${JSON.stringify((target.text ?? '').trim().toLowerCase())};
      let el = null;
      if (sel) el = document.querySelector(sel);
      if (!el && txt) {
        const cands = Array.from(document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button], summary, label, [onclick]'));
        el = cands.find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase() === txt)
          || cands.find(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(txt));
      }
      if (!el) return { ok: false };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, matched: (el.tagName + ' ' + (el.innerText || el.value || '').trim().slice(0, 60)).trim() };
    })()`
    return (await wc.executeJavaScript(script, true)) as { ok: boolean; matched?: string }
  }

  async type(nodeId: string, input: { selector?: string; text: string; submit?: boolean }): Promise<{ ok: boolean }> {
    const wc = this.need(nodeId)
    const script = `(() => {
      const sel = ${JSON.stringify(input.selector ?? '')};
      let el = sel ? document.querySelector(sel) : document.activeElement;
      if (!el || !('value' in el || el.isContentEditable)) {
        el = document.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, [contenteditable=true]');
      }
      if (!el) return { ok: false };
      el.focus();
      if (el.isContentEditable) { el.textContent = ${JSON.stringify(input.text)}; }
      else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, ${JSON.stringify(input.text)}); else el.value = ${JSON.stringify(input.text)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`
    const r = (await wc.executeJavaScript(script, true)) as { ok: boolean }
    if (r.ok && input.submit) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      wc.sendInputEvent({ type: 'char', keyCode: 'Return' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    }
    return r
  }

  async screenshot(nodeId: string, outDir: string): Promise<{ path: string }> {
    const wc = this.need(nodeId)
    // capturePage can hang without a GPU/compositor (headless CI); bound it.
    const img = await Promise.race([
      wc.capturePage(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('screenshot timed out (no compositor?) — use browser_read instead')), 10_000))
    ])
    mkdirSync(outDir, { recursive: true })
    const path = join(outDir, `browser-${nodeId}-${Date.now()}.png`)
    writeFileSync(path, img.toPNG())
    return { path }
  }

  history(nodeId: string, action: 'back' | 'forward' | 'reload'): void {
    const wc = this.need(nodeId)
    const nav = (wc as unknown as { navigationHistory?: { goBack(): void; goForward(): void } }).navigationHistory
    if (action === 'reload') wc.reload()
    else if (action === 'back') (nav ? nav.goBack() : (wc as unknown as { goBack(): void }).goBack())
    else nav ? nav.goForward() : (wc as unknown as { goForward(): void }).goForward()
  }
}
