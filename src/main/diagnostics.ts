import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tiny append-only log in userData (main.log) so a native crash leaves a trail of what the main
 * process was doing (pty lifecycle, child-process losses, uncaught errors). Rotated at 2 MB.
 */
let logFile: string | null = null

export function initDiagnostics(userData: string): void {
  try {
    mkdirSync(userData, { recursive: true })
    logFile = join(userData, 'main.log')
    try {
      if (statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1')
    } catch {
      /* no file yet */
    }
  } catch {
    logFile = null
  }
}

export function log(line: string): void {
  if (!logFile) return
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* never let logging break the app */
  }
}

export function logPath(): string | null {
  return logFile
}
