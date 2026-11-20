/**
 * What the owner is told when the app does not come up. A start that failed used to leave a process with no window
 * and no tray icon that still held the single-instance lock, so every later launch ended at once and nothing ever
 * appeared.
 */

/** A launch that has not opened its first window after this long is called stuck when the owner launches again. */
export const STILL_STARTING_MS = 20_000

export interface StartupNotice {
  title: string
  body: string
}

function where(logFile: string | null | undefined): string {
  return logFile ? `\n\nDetails are in:\n${logFile}` : ''
}

/** The error box for a start that threw before the first window. */
export function startupFailureText(err: unknown, logFile?: string | null): StartupNotice {
  const raw = String((err as Error)?.message ?? err ?? '').trim() || 'unknown error'
  const message = raw.length > 600 ? raw.slice(0, 600) + '…' : raw
  return {
    title: 'Ouroboros could not start',
    body: `${message}${where(logFile)}\n\nOuroboros will close now. Starting it again is safe.`
  }
}

/** The question for a second launch that finds the first one still without a window. */
export function stillStartingText(msSinceStart: number, logFile?: string | null): StartupNotice {
  const seconds = Math.max(0, Math.round(msSinceStart / 1000))
  return {
    title: 'Ouroboros is still starting',
    body: `It has been starting for ${seconds} seconds without opening a window.${where(logFile)}\n\nQuit it so that you can start it again?`
  }
}

/** A second launch before the first window: keep waiting quietly, or ask the owner whether to quit the stuck start. */
export function secondLaunchBeforeWindow(msSinceStart: number): 'wait' | 'ask' {
  return msSinceStart >= STILL_STARTING_MS ? 'ask' : 'wait'
}
