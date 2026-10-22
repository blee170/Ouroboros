import { describe, expect, it } from 'vitest'
import { SessionRegistry, samePath } from '../src/main/windows'

interface S {
  id: number
  projectRoot: string
  nodes: Set<string>
  hasNode(id: string): boolean
}
const mk = (id: number, projectRoot: string, nodes: string[] = []): S => {
  const set = new Set(nodes)
  return { id, projectRoot, nodes: set, hasNode: (n) => set.has(n) }
}

describe('SessionRegistry', () => {
  it('current() follows focus and falls back to the oldest window', () => {
    const r = new SessionRegistry<S>()
    const a = mk(1, '/a')
    const b = mk(2, '/b')
    r.add(a)
    r.add(b)
    expect(r.current()).toBe(b) // last added
    r.touch(1)
    expect(r.current()).toBe(a)
    r.remove(1)
    expect(r.current()).toBe(b)
    r.remove(2)
    expect(r.current()).toBeUndefined()
  })

  it('forNode finds the owning board, preferring explicit bindings', () => {
    const r = new SessionRegistry<S>()
    const a = mk(1, '/a', ['n1'])
    const b = mk(2, '/b')
    r.add(a)
    r.add(b)
    expect(r.forNode('n1')).toBe(a)
    expect(r.forNode('n2')).toBeUndefined()
    r.bindNode('n2', 2) // pty spawned before the board echoed the card
    expect(r.forNode('n2')).toBe(b)
    r.remove(2)
    expect(r.forNode('n2')).toBeUndefined()
  })

  it('forProject ignores slashes and case; forCwd picks the deepest project', () => {
    const r = new SessionRegistry<S>()
    r.add(mk(1, 'C:\\Users\\me\\proj'))
    r.add(mk(2, 'C:\\Users\\me\\proj\\sub'))
    r.add(mk(3, ''))
    expect(r.forProject('c:/users/me/proj/')?.id).toBe(1)
    expect(r.forProject('/elsewhere')).toBeUndefined()
    expect(r.forCwd('C:\\Users\\me\\proj\\sub\\x')?.id).toBe(2)
    expect(r.forCwd('C:\\Users\\me\\proj\\other')?.id).toBe(1)
    expect(r.forCwd('C:\\Users\\me\\projects')).toBeUndefined()
    expect(samePath('/a/b/', '/A/B')).toBe(true)
  })

  it('forCwd counts the app\'s own worktrees (<project>-worktrees/<slug>) as the project', () => {
    const r = new SessionRegistry<S>()
    r.add(mk(1, 'C:\\Users\\me\\proj'))
    expect(r.forCwd('C:\\Users\\me\\proj-worktrees\\impl\\src')?.id).toBe(1)
    expect(r.forCwd('C:\\Users\\me\\proj\\.claude\\worktrees\\x')?.id).toBe(1)
    expect(r.forCwd('C:\\Users\\me\\proj-worktreesX')).toBeUndefined()
  })

  it('forExternal never falls back to the focused window and evicts a window that stopped matching', () => {
    const r = new SessionRegistry<S>()
    const a = mk(1, 'C:\\Users\\me\\.claudecode\\chill-shuttle')
    const b = mk(2, 'C:\\Users\\me\\Ouroboros')
    r.add(a)
    r.touch(1) // chill-shuttle is focused
    // only chill-shuttle open: a session from elsewhere is shown nowhere
    expect(r.forExternal('C:\\Users\\me\\Ouroboros\\.claude\\worktrees\\s1')).toEqual({ target: undefined, evict: undefined })
    expect(r.forExternal('')).toEqual({ target: undefined, evict: undefined })
    // it had landed in chill-shuttle (old fallback): evict it, even with no better window
    expect(r.forExternal('C:\\Users\\me\\Ouroboros\\.claude\\worktrees\\s1', 1)).toEqual({ target: undefined, evict: a })
    // the Ouroboros window opens: it becomes the target and chill-shuttle still drops the card
    r.add(b)
    expect(r.forExternal('C:\\Users\\me\\Ouroboros\\.claude\\worktrees\\s1', 1)).toEqual({ target: b, evict: a })
    // already in the right window: nothing to evict
    expect(r.forExternal('C:\\Users\\me\\Ouroboros\\.claude\\worktrees\\s1', 2)).toEqual({ target: b, evict: undefined })
    expect(r.forExternal('C:\\Users\\me\\Ouroboros', 2)).toEqual({ target: b, evict: undefined })
  })
})
