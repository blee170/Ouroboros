/**
 * Which agent CLIs are installed and signed in, so a ChatGPT or Gemini user can set up without
 * touching Claude at all. Detection is best-effort and read-only: `<cli> --version` with a timeout,
 * plus the credential files each CLI writes after sign-in.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
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

/** Pure: sign-in state from the files each CLI keeps (undefined only when the files cannot be read). */
export function signedInFromFiles(engine: AgentEngine, home: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean, read: (p: string) => string): boolean | undefined {
  try {
    if (engine === 'claude') {
      if (exists(join(home, '.claude', '.credentials.json'))) return true
      const cfg = join(home, '.claude.json')
      if (exists(cfg)) {
        const j = JSON.parse(read(cfg)) as { oauthAccount?: unknown; primaryApiKey?: unknown }
        if (j.oauthAccount || j.primaryApiKey) return true
      }
      return Boolean(env.ANTHROPIC_API_KEY)
    }
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
