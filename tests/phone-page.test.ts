import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PHONE_JS } from '../src/main/phone-page'

/** Just enough of a DOM for the page's card sheet: elements in a tree, ids, text, listeners, clicks. */
class El {
  children: El[] = []
  parent: El | null = null
  listeners: Record<string, Array<(e: unknown) => void>> = {}
  attrs: Record<string, string> = {}
  style: Record<string, string> = {}
  classList = { toggle: () => {}, add: () => {}, remove: () => {} }
  className = ''
  id = ''
  hidden = false
  disabled = false
  value = ''
  own = ''
  constructor(public tagName: string) {}
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join('')
  }
  set textContent(v: string) {
    for (const c of this.children) c.parent = null
    this.children = []
    this.own = v
  }
  appendChild(c: El): El {
    if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1)
    c.parent = this
    this.children.push(c)
    return c
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null
  }
  addEventListener(type: string, f: (e: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(f)
  }
  dispatch(type: string, e: unknown): void {
    for (const f of this.listeners[type] ?? []) f(e)
  }
  /** a disabled button takes no tap, as in a browser */
  click(): void {
    if (!this.disabled) this.dispatch('click', { target: this })
  }
  contains(o: El | null): boolean {
    for (let x = o; x; x = x.parent) if (x === this) return true
    return false
  }
  querySelectorAll(): El[] {
    return []
  }
  find(id: string): El | undefined {
    if (this.id === id) return this
    for (const c of this.children) {
      const f = c.find(id)
      if (f) return f
    }
    return undefined
  }
  blur(): void {}
}

interface Xhr {
  status: number
  responseText: string
  onload: () => void
  body: unknown
}

/** The real page script, paired, on a board that does not refresh; the test answers its requests. */
function page() {
  const body = new El('BODY')
  for (const id of ['toast', 'tabs', 'badge', 'view', 'sub', 'live', 'pick-photo', 'pick-file']) body.appendChild(new El('DIV')).id = id
  const sheet = body.appendChild(new El('DIV'))
  sheet.id = 'sheet'
  sheet.hidden = true
  sheet.appendChild(new El('DIV')).id = 'sheet-body'
  const posts: Array<{ path: string; body: unknown; answer: (status: number, json: unknown) => void }> = []
  const xhrs: Xhr[] = []
  const revoked: string[] = []
  const g: Record<string, unknown> = {
    document: {
      createElement: (t: string) => new El(t.toUpperCase()),
      createElementNS: (_ns: string, t: string) => new El(t),
      getElementById: (id: string) => body.find(id) ?? null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      activeElement: null,
      hidden: false,
      title: ''
    },
    window: { addEventListener: () => {} },
    localStorage: { getItem: (k: string) => (k === 'ouroboros-phone-token' ? 'token' : null), setItem: () => {}, removeItem: () => {} },
    location: { hash: '' },
    history: { replaceState: () => {} },
    navigator: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    URL: { createObjectURL: (f: { name: string }) => `blob:${f.name}`, revokeObjectURL: (u: string) => void revoked.push(u) },
    XMLHttpRequest: class {
      upload = {}
      open(): void {}
      setRequestHeader(): void {}
      send(b: unknown): void {
        ;(this as unknown as Xhr).body = b
        xhrs.push(this as unknown as Xhr)
      }
      abort(): void {}
    },
    fetch: (url: string, init: { method: string; body?: string }) =>
      // the board poll never answers: the sheet is the test's to draw
      init.method === 'GET'
        ? new Promise(() => {})
        : new Promise((resolve) => posts.push({ path: url, body: init.body ? JSON.parse(init.body) : undefined, answer: (status, json) => resolve({ status, ok: status < 400, text: () => Promise.resolve(JSON.stringify(json)) }) }))
  }
  runInNewContext(PHONE_JS, g)
  const el = (id: string): El => body.find(id)!
  const pick = (name: string): Xhr => {
    el('attach-photo').click()
    el('pick-photo').dispatch('change', { target: { files: [{ name, size: 1000, type: 'image/png' }], value: '' } })
    return xhrs[xhrs.length - 1]
  }
  const uploaded = (x: Xhr, id: string): void => {
    x.status = 200
    x.responseText = JSON.stringify({ id })
    x.onload()
  }
  return { g, el, pick, uploaded, posts, revoked }
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('the phone page', () => {
  it('keeps a file picked while a message is on its way: it goes with the next message', async () => {
    const p = page()
    await settle() // its first draw and board poll
    ;(p.g.state as { board: unknown }).board = { project: 'p', cards: [{ id: 'c1', title: 'Worker', status: 'idle', promptable: true }], approvals: [], decisions: [], tasks: [] }
    ;(p.g.openCard as (id: string) => void)('c1')
    p.uploaded(p.pick('first.png'), 'u1')
    p.el('composer').value = 'look at this'
    p.el('send').click()
    expect(p.posts.map((x) => x.body)).toEqual([{ text: 'look at this', files: ['u1'] }])
    // picked while that message is on its way
    const second = p.pick('second.png')
    p.posts[0].answer(200, { ok: true })
    await settle()
    await settle()
    expect(p.el('chips').textContent).toContain('second.png')
    expect(p.el('chips').textContent).not.toContain('first.png')
    expect(p.revoked).toEqual(['blob:first.png'])
    p.uploaded(second, 'u2')
    p.el('send').click()
    expect(p.posts.map((x) => x.body)).toEqual([
      { text: 'look at this', files: ['u1'] },
      { text: '', files: ['u2'] }
    ])
  })

  it('says on the Restart sheet what the relaunch does to the conversation', async () => {
    const p = page()
    await settle()
    ;(p.g.state as { board: unknown }).board = { project: 'p', cards: [{ id: 'c2', title: 'Worker', status: 'ended', promptable: false, restartable: true, relaunch: 'resume' }], approvals: [], decisions: [], tasks: [] }
    ;(p.g.openCard as (id: string) => void)('c2')
    p.el('restart').click()
    expect(p.el('sheet-body').textContent).toContain('Restart Worker?Its CLI starts again and resumes its conversation.Cancel')
  })
})
