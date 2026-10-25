import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globalExternalHooksInstalled, loadExternalToken, setGlobalExternalHooks } from '../src/main/external'

describe('setGlobalExternalHooks', () => {
  it('adds and removes our hooks without touching others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ouro-ext-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }))
    setGlobalExternalHooks(true, 'http://127.0.0.1:47821', 'ext-token', file)
    let s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.model).toBe('x')
    expect(s.hooks.Stop).toHaveLength(2)
    expect(s.hooks.SessionStart[0].hooks[0].url).toBe('http://127.0.0.1:47821/hook/external')
    expect(s.hooks.SessionStart[0].hooks[0].headers).toEqual({ 'x-ouroboros-token': 'ext-token' })
    expect(globalExternalHooksInstalled(file)).toBe(true)
    setGlobalExternalHooks(true, 'http://127.0.0.1:47821', 'ext-token', file) // idempotent
    s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.hooks.Stop).toHaveLength(2)
    setGlobalExternalHooks(false, 'http://127.0.0.1:47821', 'ext-token', file)
    s = JSON.parse(readFileSync(file, 'utf8'))
    expect(s.hooks.Stop).toHaveLength(1)
    expect(s.hooks.SessionStart).toBeUndefined()
    expect(globalExternalHooksInstalled(file)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

describe('loadExternalToken', () => {
  it('creates one token and keeps it across launches, replacing a damaged file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ouro-ext-tok-'))
    const a = loadExternalToken(dir)
    expect(a).toMatch(/^[0-9a-f]{48}$/)
    expect(loadExternalToken(dir)).toBe(a)
    writeFileSync(join(dir, 'external-hook.token'), 'garbage')
    const b = loadExternalToken(dir)
    expect(b).toMatch(/^[0-9a-f]{48}$/)
    expect(b).not.toBe(a)
    expect(globalExternalHooksInstalled(join(dir, 'missing.json'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
})
