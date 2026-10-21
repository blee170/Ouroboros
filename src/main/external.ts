import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildHookSettings } from './claude-launcher'

const EXTERNAL_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']

export function userSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
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
export function setGlobalExternalHooks(enable: boolean, baseUrl: string, file = userSettingsPath()): void {
  let settings: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
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
    const ours = buildHookSettings(baseUrl, 'external', EXTERNAL_EVENTS).hooks as Record<string, HookGroup[]>
    for (const ev of Object.keys(ours)) hooks[ev] = [...(hooks[ev] ?? []), ...ours[ev]]
  }
  settings.hooks = hooks
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}
