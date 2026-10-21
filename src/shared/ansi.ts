// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export function stripAnsi(input: string): string {
  return input.replace(OSC_RE, '').replace(ANSI_RE, '').replace(/\r/g, '')
}

/** Last `lines` lines of a terminal buffer, ANSI stripped. */
export function tailLines(buffer: string, lines: number): string {
  const clean = stripAnsi(buffer)
  const parts = clean.split('\n')
  return parts.slice(Math.max(0, parts.length - lines)).join('\n')
}
