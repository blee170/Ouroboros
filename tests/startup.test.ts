import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STILL_STARTING_MS, secondLaunchBeforeWindow, startupFailureText, stillStartingText } from '../src/main/startup'

describe('a start that fails or hangs before the first window', () => {
  it('tells the owner what failed and where the log is', () => {
    const t = startupFailureText(new Error('listen EACCES: permission denied 127.0.0.1:47821'), 'C:\\Users\\x\\AppData\\Roaming\\Ouroboros\\main.log')
    expect(t.title).toBe('Ouroboros could not start')
    expect(t.body).toContain('listen EACCES')
    expect(t.body).toContain('main.log')
    expect(t.body).toContain('will close')
  })

  it('still says something for an error with no message, and cuts a very long one', () => {
    expect(startupFailureText(undefined).body).toContain('unknown error')
    expect(startupFailureText('plain string').body).toContain('plain string')
    expect(startupFailureText(new Error('x'.repeat(5000)), null).body.length).toBeLessThan(800)
  })

  it('a second launch waits quietly at first and asks once the start is clearly stuck', () => {
    expect(secondLaunchBeforeWindow(0)).toBe('wait')
    expect(secondLaunchBeforeWindow(STILL_STARTING_MS - 1)).toBe('wait')
    expect(secondLaunchBeforeWindow(STILL_STARTING_MS)).toBe('ask')
    const t = stillStartingText(95_400, 'C:\\main.log')
    expect(t.body).toContain('95 seconds')
    expect(t.body).toContain('C:\\main.log')
  })

  it('main() never runs without a catch, and hears a second launch before anything can fail', () => {
    const src = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    expect(src).toContain('void main().catch(startupFailed)')
    expect(src).not.toMatch(/void main\(\)\s*$/m)
    const lock = src.indexOf('requestSingleInstanceLock()')
    const second = src.indexOf("app.on('second-instance'")
    expect(lock).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(lock)
    expect(second).toBeLessThan(src.indexOf('await app.whenReady()'))
    expect(src.split("app.on('second-instance'").length - 1).toBe(1)
  })
})
