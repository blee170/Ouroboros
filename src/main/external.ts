import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildHookSettings } from './claude-launcher'

const EXTERNAL_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']

export function userSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
}

/**
 * The token the global hook sends with `/hook/external`. It is written into the owner's Claude Code settings, so it
 * outlives a launch: kept in the app's data folder, created on first use.
 */
export function loadExternalToken(dir: string): string {
  const file = join(dir, 'external-hook.token')
  try {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{48}$/.test(t)) return t
  } catch {
    /* first launch, or unreadable: make a new one */
  }
  const t = randomBytes(24).toString('hex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, t, { encoding: 'utf8', mode: 0o600 })
  return t
}

/** Whether the owner's settings carry our global hook (the external-sessions switch was turned on). */
export function globalExternalHooksInstalled(file = userSettingsPath()): boolean {
  try {
    const hooks = (JSON.parse(readFileSync(file, 'utf8')) as { hooks?: Record<string, HookGroup[]> }).hooks ?? {}
    return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some(isOurs))
  } catch {
    return false
  }
}

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; url?: string }> }

function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some((h) => h.type === 'http' && typeof h.url === 'string' && /\/hook\/external$/.test(h.url))
}

/**
 * Add (or remove) a global HTTP hook so Claude Code sessions started outside Ouroboros
 * (e.g. the Windows Claude desktop app's Code tab, a plain terminal) report to us too.
 * Other hooks in the user's settings are preserved.
 */
export function setGlobalExternalHooks(enable: boolean, baseUrl: string, token: string, file = userSettingsPath()): void {
  let settings: Record<string, unknown> = {}
  let before = ''
  if (existsSync(file)) {
    try {
      before = readFileSync(file, 'utf8')
      settings = JSON.parse(before) as Record<string, unknown>
    } catch (e) {
      throw new Error(`Cannot parse ${file}: ${(e as Error).message}`)
    }
  }
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, HookGroup[]>
  // strip our previous entries
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue
    hooks[ev] = hooks[ev].filter((g) => !isOurs(g))
    if (hooks[ev].length === 0) delete hooks[ev]
  }
  if (enable) {
    // these hooks run in sessions we did not start, so the token is written into them (it only reaches the sidebar)
    const ours = buildHookSettings(baseUrl, 'external', EXTERNAL_EVENTS, { token }).hooks as Record<string, HookGroup[]>
    for (const ev of Object.keys(ours)) hooks[ev] = [...(hooks[ev] ?? []), ...ours[ev]]
  }
  settings.hooks = hooks
  const after = JSON.stringify(settings, null, 2) + '\n'
  // the app writes this again at every start: leave the owner's file untouched when nothing changed
  if (after === before.replace(/\r\n/g, '\n')) return
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, after, 'utf8')
}
