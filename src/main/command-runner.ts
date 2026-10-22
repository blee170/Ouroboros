import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { stripAnsi } from '@shared/ansi'
import { quoteArg } from './claude-launcher'
import { shellKind, type ShellKind } from './pty-manager'

export interface RunningCommand {
  nonce: string
  startedAt: number
  buffer: string
}

export const startMarker = (nonce: string): string => `__OURO_START_${nonce}__`
export const doneMarker = (nonce: string): string => `__OURO_DONE_${nonce}__`

/** `echo` of a marker written so the typed command line never contains the marker verbatim (shells echo input). */
function echoSplit(kind: ShellKind, marker: string): string {
  const [a, b] = ['__OURO_', marker.slice('__OURO_'.length)]
  if (kind === 'powershell') return `Write-Output ("${a}" + "${b}")`
  if (kind === 'cmd') return `echo ${a}^${b}`
  return `echo ${a}""${b}`
}

/** Build the shell line for a command card: start marker, template with placeholders, done marker. */
export function buildCommandLine(template: string, prompt: string, opts: { shell: string; tmpDir: string; nodeId: string }): { line: string; nonce: string } {
  const kind: ShellKind = shellKind(opts.shell)
  const nonce = randomBytes(4).toString('hex')
  mkdirSync(opts.tmpDir, { recursive: true })
  const promptFile = join(opts.tmpDir, `${opts.nodeId}-${nonce}.prompt.txt`)
  writeFileSync(promptFile, prompt, 'utf8')
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  const cmd = template.replace(/\{\{\s*prompt\s*\}\}/g, quoteArg(oneLine, kind)).replace(/\{\{\s*prompt_file\s*\}\}/g, quoteArg(promptFile, kind))
  const sep = kind === 'cmd' ? ' & ' : '; '
  const line = [echoSplit(kind, startMarker(nonce)), cmd, echoSplit(kind, doneMarker(nonce))].join(sep)
  return { line, nonce }
}

/** Output between the start and done markers (ANSI stripped), or null while still running. */
export function extractCompleted(buffer: string, nonce: string): string | null {
  const clean = stripAnsi(buffer)
  const s = clean.indexOf(startMarker(nonce))
  if (s < 0) return null
  const d = clean.indexOf(doneMarker(nonce), s)
  if (d < 0) return null
  const bodyStart = clean.indexOf('\n', s)
  if (bodyStart < 0 || bodyStart > d) return ''
  return clean.slice(bodyStart + 1, d).replace(/\r/g, '').replace(/\n+$/g, '').trim()
}
