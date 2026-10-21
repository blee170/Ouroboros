import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setGlobalExternalHooks } from '../src/main/external'

describe('setGlobalExternalHooks', () => {
  it('adds and removes our hooks without touching others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ouro-ext-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }))
    setGlobalExternalHooks(true, 'http://127.0.0.1:47821', file)
    let s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.model).toBe('x')
    expect(s.hooks.Stop).toHaveLength(2)
    expect(s.hooks.SessionStart[0].hooks[0].url).toBe('http://127.0.0.1:47821/hook/external')
    setGlobalExternalHooks(true, 'http://127.0.0.1:47821', file) // idempotent
    s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.hooks.Stop).toHaveLength(2)
    setGlobalExternalHooks(false, 'http://127.0.0.1:47821', file)
    s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.hooks.Stop).toHaveLength(1)
    expect(s.hooks.SessionStart).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })
})
