import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

let cached: string | undefined | null = null

/**
 * Locate a system Node.js binary for running the bundled MCP server. Using plain node avoids
 * ELECTRON_RUN_AS_NODE quirks in signed/packaged builds. Returns undefined when none is found.
 */
export function findNodeBinary(): string | undefined {
  if (cached !== null) return cached
  const fromEnv = process.env.OUROBOROS_NODE
  if (fromEnv && existsSync(fromEnv)) return (cached = fromEnv)
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node']
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return (cached = candidate)
    }
  }
  if (process.platform === 'win32') {
    const guesses = [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs', 'node.exe')]
    for (const g of guesses) if (existsSync(g)) return (cached = g)
  }
  return (cached = undefined)
}
