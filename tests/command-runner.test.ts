import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommandLine, doneMarker, extractCompleted, startMarker } from '../src/main/command-runner'

describe('command cards', () => {
  it('substitutes placeholders with shell quoting and wraps the command in markers the typed line never contains', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ouro-cmd-'))
    const { line, nonce } = buildCommandLine('aside exec {{prompt}} --file {{prompt_file}}', 'open "github"\nand read it', { shell: '/bin/bash', tmpDir: tmp, nodeId: 'n1' })
    expect(line).toBe(`echo __OURO_""START_${nonce}__; aside exec 'open "github" and read it' --file '${join(tmp, `n1-${nonce}.prompt.txt`)}'; echo __OURO_""DONE_${nonce}__`)
    expect(line).not.toContain(startMarker(nonce))
    expect(readFileSync(join(tmp, `n1-${nonce}.prompt.txt`), 'utf8')).toBe('open "github"\nand read it')
    const ps = buildCommandLine('aside exec {{prompt}}', 'hi $there', { shell: 'powershell.exe', tmpDir: tmp, nodeId: 'n2' })
    expect(ps.line).toBe(`Write-Output ("__OURO_" + "START_${ps.nonce}__"); aside exec "hi \`$there"; Write-Output ("__OURO_" + "DONE_${ps.nonce}__")`)
    const c = buildCommandLine('dir {{prompt}}', 'x', { shell: 'cmd.exe', tmpDir: tmp, nodeId: 'n3' })
    expect(c.line).toBe(`echo __OURO_^START_${c.nonce}__ & dir "x" & echo __OURO_^DONE_${c.nonce}__`)
    rmSync(tmp, { recursive: true, force: true })
  })
  it('extracts the output between the markers, ignoring the echoed command line', () => {
    const nonce = 'abcd1234'
    const typed = `$ echo __OURO_""START_${nonce}__; aside exec 'x'; echo __OURO_""DONE_${nonce}__\r\n`
    const buf = typed + `${startMarker(nonce)}\r\n\u001b[32mworking…\u001b[0m\r\nRESULT: done\r\n${doneMarker(nonce)}\r\n$ `
    expect(extractCompleted(buf, nonce)).toBe('working…\nRESULT: done')
    expect(extractCompleted(typed + `${startMarker(nonce)}\r\nstill running`, nonce)).toBeNull()
    expect(extractCompleted(typed, nonce)).toBeNull()
  })
})
