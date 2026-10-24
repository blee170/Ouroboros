/**
 * Which agent CLIs are installed and signed in, so a ChatGPT or Gemini user can set up without
 * touching Claude at all. Detection is best-effort and read-only: `<cli> --version` with a timeout,
 * plus the credential files each CLI writes after sign-in.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { AgentEngine } from '@shared/types'
import type { EngineInfo } from '@shared/protocol'
import { findNodeBinary } from './node-runner'

export const ENGINE_META: Record<AgentEngine, { label: string; bin: string; install: string; login: string; signupUrl: string; needsNode: boolean }> = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    install: process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
    login: 'claude',
    signupUrl: 'https://claude.ai/',
    needsNode: false
  },
  codex: {
    label: 'OpenAI Codex CLI (ChatGPT)',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    signupUrl: 'https://chatgpt.com/',
    needsNode: true
  },
  gemini: {
    label: 'Gemini CLI (Google)',
    bin: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    login: 'gemini',
    signupUrl: 'https://aistudio.google.com/',
    needsNode: true
  }
}

/** Pure: first semver-looking token of a `--version` output. */
export function parseVersion(output: string): string | undefined {
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)
  return m?.[1]
}

/** Environment variables Claude Code reads as an "external API key", which it prefers over its own sign-in. */
export const CLAUDE_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, else ~/.claude (the same rule as claude-history.ts and external.ts). */
export function claudeConfigDirOf(env: NodeJS.ProcessEnv, home: string): string {
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude')
}

/**
 * Pure: whether `claude` is signed in: `.credentials.json` in its config folder, or an account / saved key in
 * `.claude.json` (next to the folder by default, inside it under CLAUDE_CONFIG_DIR). undefined when a file cannot be read.
 */
export function claudeLoginFromFiles(configDir: string, exists: (p: string) => boolean, read: (p: string) => string): boolean | undefined {
  try {
    if (exists(join(configDir, '.credentials.json'))) return true
    const cfg = [join(configDir, '.claude.json'), join(dirname(configDir), '.claude.json')].find(exists)
    if (cfg) {
      const j = JSON.parse(read(cfg)) as { oauthAccount?: unknown; primaryApiKey?: unknown }
      if (j.oauthAccount || j.primaryApiKey) return true
    }
    return false
  } catch {
    return undefined
  }
}

function isAnthropicApi(url: string): boolean {
  try {
    return new URL(url).host.toLowerCase() === 'api.anthropic.com'
  } catch {
    return false
  }
}

/**
 * Pure: the key variables a Claude card must not inherit. A key in the environment overrides the sign-in inside
 * Claude Code ("Invalid API key · Fix external API key" on every turn when it is stale), so when `claude` is signed
 * in the key is dropped from the card unless the owner keeps it on purpose. With no sign-in the key is all there is
 * and stays; so does a key that belongs to a gateway (`ANTHROPIC_BASE_URL` pointing anywhere but api.anthropic.com),
 * where the sign-in would not work. Windows environment names are case-insensitive: every spelling is listed.
 */
export function claudeEnvKeysToStrip(env: NodeJS.ProcessEnv, signedIn: boolean | undefined, keepEnvKey: boolean): string[] {
  if (keepEnvKey || signedIn !== true) return []
  const baseUrl = Object.keys(env).find((k) => k.toUpperCase() === 'ANTHROPIC_BASE_URL')
  if (baseUrl && (env[baseUrl] ?? '').trim() && !isAnthropicApi((env[baseUrl] ?? '').trim())) return []
  const wanted = new Set<string>(CLAUDE_KEY_VARS)
  return Object.keys(env).filter((k) => wanted.has(k.toUpperCase()) && (env[k] ?? '') !== '')
}

/**
 * Pure: sign-in state from the files each CLI keeps (undefined only when the files cannot be read). For Claude an
 * API key in the environment does not count: the app drops it from the cards of a signed-in owner (see
 * `claudeEnvKeysToStrip`), and a key alone still needs `claude` once to accept it.
 */
export function signedInFromFiles(engine: AgentEngine, home: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean, read: (p: string) => string): boolean | undefined {
  try {
    if (engine === 'claude') return claudeLoginFromFiles(claudeConfigDirOf(env, home), exists, read)
    if (engine === 'codex') {
      if (exists(join(home, '.codex', 'auth.json'))) return true
      return Boolean(env.OPENAI_API_KEY)
    }
    if (exists(join(home, '.gemini', 'oauth_creds.json'))) return true
    return Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY)
  } catch {
    return undefined
  }
}

/**
 * PATH as the app saw it at launch plus the folders the installers use, so a CLI installed while
 * Ouroboros is open is found on re-check without a restart.
 */
function probePath(): string {
  const home = homedir()
  const extra =
    process.platform === 'win32'
      ? [join(home, '.local', 'bin'), join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs')]
      : [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', join(home, '.npm-global', 'bin')]
  return [process.env.PATH ?? '', ...extra].filter(Boolean).join(delimiter)
}

function run(cmd: string, args: string[], timeout = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // shell: npm installs .cmd shims on Windows
    execFile(cmd, args, { shell: process.platform === 'win32', timeout, windowsHide: true, env: { ...process.env, PATH: probePath(), Path: probePath() } }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout ?? ''}\n${stderr ?? ''}` })
    })
  })
}

export async function detectEngines(): Promise<EngineInfo[]> {
  const node = findNodeBinary()
  const home = homedir()
  return Promise.all(
    (['claude', 'codex', 'gemini'] as AgentEngine[]).map(async (engine) => {
      const meta = ENGINE_META[engine]
      const r = await run(meta.bin, ['--version'])
      return {
        engine,
        label: meta.label,
        installed: r.ok,
        version: r.ok ? parseVersion(r.out) : undefined,
        signedIn: r.ok ? signedInFromFiles(engine, home, process.env, existsSync, (p) => readFileSync(p, 'utf8')) : undefined,
        installCommand: meta.install,
        loginCommand: meta.login,
        signupUrl: meta.signupUrl,
        needsNode: meta.needsNode,
        nodeAvailable: Boolean(node)
      }
    })
  )
}
