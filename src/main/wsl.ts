/** WSL2 cards (experimental): find the distro and check it can run a sandboxed Claude card that reaches the app. */
import { execFile } from 'node:child_process'
import { SAFE_DISTRO, parseDistros, preflightScript, readPreflight, type WslCheck } from '@shared/wsl'

function run(args: string[], timeout: number): Promise<{ ok: boolean; out: Buffer }> {
  return new Promise((resolve) => {
    execFile('wsl.exe', args, { windowsHide: true, timeout, encoding: 'buffer', maxBuffer: 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: stdout ?? Buffer.alloc(0) }))
  })
}

/** The distro a WSL card runs in: the one named in Settings when it exists, else the first one that is not Docker Desktop's. */
export async function pickDistro(preferred: string | undefined): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const r = await run(['-l', '-q'], 10_000)
  if (!r.ok) return undefined
  const list = parseDistros(r.out.includes(0) ? r.out.toString('utf16le') : r.out.toString('utf8')).filter((d) => SAFE_DISTRO.test(d))
  return preferred && list.includes(preferred) ? preferred : list[0]
}

/** Probe the distro (a login shell, so ~/.local/bin is on PATH): claude, the sandbox tools, the sign-in, and the hook server. */
export async function wslPreflight(preferred: string | undefined, port: number): Promise<WslCheck> {
  const distro = await pickDistro(preferred)
  if (!distro) return readPreflight(undefined, undefined)
  // the first start of a stopped distro can take a while
  const r = await run(['-d', distro, '-e', 'bash', '-lc', preflightScript(port)], 30_000)
  return readPreflight(distro, r.ok ? r.out.toString('utf8') : undefined)
}
