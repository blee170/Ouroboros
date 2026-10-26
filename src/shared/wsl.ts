/**
 * Claude cards inside WSL2 with Claude Code's sandbox on (RESEARCH §11 Type 1 (e), experimental): native Windows has
 * no Claude sandbox, WSL2 has bubblewrap. The card still runs in a Windows terminal; `wsl.exe` starts `claude` in the
 * distro, in the card's folder seen through /mnt/<drive>. The hook server stays on Windows' 127.0.0.1, which a WSL
 * process reaches only in mirrored networking mode; the board's MCP server and the gate helper stay Windows programs,
 * started from Linux through WSL interop.
 */

/** Pure: a Windows path as WSL sees it (C:\a\b → /mnt/c/a/b); undefined for a path WSL does not mount this way (UNC, relative). */
export function toWslPath(winPath: string): string | undefined {
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(winPath.trim())
  if (!m) return undefined
  const rest = m[2].split(/[\\/]+/).filter(Boolean).join('/')
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`
}

/** Pure: distro names from `wsl.exe -l -q` (decoded text; it is UTF-16LE on most systems), without Docker Desktop's own. */
export function parseDistros(text: string): string[] {
  return text
    .replace(/\uFEFF/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter((l) => l && !/^docker-desktop/i.test(l))
}

/** A distro name safe to put on a command line. */
export const SAFE_DISTRO = /^[A-Za-z0-9._-]{1,64}$/

/** The probe run in the distro: one marker line per thing found. Bash's /dev/tcp checks the hook server without curl. */
export function preflightScript(port: number): string {
  return [
    'command -v claude >/dev/null && echo HAS_CLAUDE',
    'command -v bwrap >/dev/null && echo HAS_BWRAP',
    'command -v socat >/dev/null && echo HAS_SOCAT',
    'command -v git >/dev/null && echo HAS_GIT',
    'command -v curl >/dev/null && echo HAS_CURL',
    '{ test -f ~/.claude/.credentials.json || grep -qs oauthAccount ~/.claude.json; } && echo HAS_LOGIN',
    `(exec 3<>/dev/tcp/127.0.0.1/${Math.trunc(port)}) 2>/dev/null && echo HAS_HUB`,
    'true'
  ].join('; ')
}

export interface WslCheck {
  ok: boolean
  distro?: string
  /** what is missing, each with what to do (in order) */
  missing: string[]
  /** not blocking (the card works, something small is off) */
  notes: string[]
}

/** Pure: what the probe found, and what to do about the rest. */
export function readPreflight(distro: string | undefined, out: string | undefined): WslCheck {
  if (!distro) return { ok: false, missing: ['No Linux distribution: run `wsl --install -d Ubuntu` in an admin terminal, restart if asked, and create the Linux user.'], notes: [] }
  if (out === undefined) return { ok: false, distro, missing: [`${distro} did not answer (is WSL working? try \`wsl -d ${distro}\` in a terminal).`], notes: [] }
  const has = new Set(out.split(/\r?\n/).map((l) => l.trim()))
  const missing: string[] = []
  if (!has.has('HAS_CLAUDE')) missing.push(`Claude Code inside ${distro}: \`curl -fsSL https://claude.ai/install.sh | bash\` in \`wsl -d ${distro}\`.`)
  if (!has.has('HAS_BWRAP') || !has.has('HAS_SOCAT')) missing.push(`The sandbox's tools: \`sudo apt-get install bubblewrap socat\` in \`wsl -d ${distro}\`.`)
  if (has.has('HAS_CLAUDE') && !has.has('HAS_LOGIN')) missing.push(`Sign in once inside ${distro}: run \`claude\` there and finish the login.`)
  if (!has.has('HAS_HUB')) missing.push('Mirrored networking, so the card can reach the app on 127.0.0.1: put `[wsl2]` and `networkingMode=mirrored` in %UserProfile%\\.wslconfig, then `wsl --shutdown`.')
  const notes: string[] = []
  if (!has.has('HAS_GIT')) notes.push(`git is not installed in ${distro} (\`sudo apt-get install git\`): the card cannot commit or push.`)
  if (!has.has('HAS_CURL')) notes.push(`curl is not installed in ${distro}: the card's context and usage meters stay empty.`)
  return { ok: missing.length === 0, distro, missing, notes }
}

/** Settings merged into a WSL card's --settings: the sandbox on, refusing to start without it, no unsandboxed retry. */
export const WSL_SANDBOX_SETTINGS = { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } } as const

/**
 * Pure: the WSL card's sandbox settings with paths. Sandboxed commands may not read Windows' own programs or the WSL
 * interop socket (a cmd.exe started from Linux runs as the owner, outside the sandbox), nor the owner's credentials
 * under the Windows home; and may not write the files the owner's own tools run later outside the sandbox (git hooks,
 * Claude settings, the board file). Claude itself, its hooks and its MCP servers are not sandboxed and still use interop.
 */
export function wslSandboxSettings(cwd: string, winHome: string): Record<string, unknown> {
  const home = toWslPath(winHome)
  const dir = toWslPath(cwd)
  const denyRead = ['/run/WSL', '/mnt/c/Windows', ...(home ? ['.ssh', '.git-credentials', '.config/gh', 'AppData/Roaming/GitHub CLI', '.aws', '.azure', '.docker', '.claude', 'AppData/Roaming/Ouroboros'].map((p) => `${home}/${p}`) : [])]
  const denyWrite = dir ? ['.git/hooks', '.git/config', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.ouroboros.json'].map((p) => `${dir}/${p}`) : []
  return { sandbox: { ...WSL_SANDBOX_SETTINGS.sandbox, filesystem: { denyRead, denyWrite } } }
}

/**
 * Pure: WSLENV for the card. Windows passes only the variables WSLENV names into Linux, and Linux passes only those
 * on to the Windows programs it starts (the MCP server, the gate helper), so every name the card and those helpers need
 * is listed; nothing else of the owner's environment crosses.
 */
export function wslEnvNames(names: string[], existing: string | undefined): string {
  const out: string[] = []
  for (const n of [...(existing ?? '').split(':'), ...names]) {
    const name = n.trim()
    if (name && /^[A-Za-z_][A-Za-z0-9_]*(\/[ptlwu]+)?$/.test(name) && !out.some((o) => o.split('/')[0] === name.split('/')[0])) out.push(name)
  }
  return out.join(':')
}

/** Variables the board's MCP server and hooks set for themselves inside the card; they must cross back to Windows. */
export const WSL_HELPER_ENV = ['OUROBOROS_URL', 'OUROBOROS_TOKEN', 'OUROBOROS_SELF_ID', 'OUROBOROS_TOOLS', 'OUROBOROS_NODE_ID', 'ELECTRON_RUN_AS_NODE']

