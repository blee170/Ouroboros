import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WSL_HELPER_ENV, parseDistros, preflightScript, readPreflight, toWslPath, wslEnvNames } from '@shared/wsl'
import { buildGateCommand, buildWslClaudeCommand, prepareLaunch } from '../src/main/claude-launcher'

describe('toWslPath', () => {
  it('maps drive paths to /mnt and refuses the rest', () => {
    expect(toWslPath('C:\\Users\\piz91\\Ouroboros')).toBe('/mnt/c/Users/piz91/Ouroboros')
    expect(toWslPath('D:/a//b/')).toBe('/mnt/d/a/b')
    expect(toWslPath('c:\\')).toBe('/mnt/c')
    for (const bad of ['\\\\server\\share\\x', 'relative\\x', '/already/linux', '']) expect(toWslPath(bad)).toBeUndefined()
  })
})

describe('parseDistros', () => {
  it("reads wsl -l -q output and drops Docker Desktop's distros", () => {
    expect(parseDistros('\uFEFFUbuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n\r\n')).toEqual(['Ubuntu', 'Debian'])
    expect(parseDistros('docker-desktop\r\n')).toEqual([])
  })
})

describe('readPreflight', () => {
  const all = 'HAS_CLAUDE\nHAS_BWRAP\nHAS_SOCAT\nHAS_GIT\nHAS_CURL\nHAS_LOGIN\nHAS_HUB\n'
  it('is ready when everything is there', () => {
    expect(readPreflight('Ubuntu', all)).toEqual({ ok: true, distro: 'Ubuntu', missing: [], notes: [] })
  })
  it('says what to do for each missing piece, in order', () => {
    expect(readPreflight(undefined, undefined).missing[0]).toMatch(/wsl --install -d Ubuntu/)
    expect(readPreflight('Ubuntu', undefined).missing[0]).toMatch(/did not answer/)
    const r = readPreflight('Ubuntu', 'HAS_GIT\n')
    expect(r.ok).toBe(false)
    expect(r.missing.map((m) => m.slice(0, 20))).toEqual(['Claude Code inside U', "The sandbox's tools:", 'Mirrored networking,'])
    expect(readPreflight('Ubuntu', all.replace('HAS_LOGIN\n', '')).missing).toEqual([expect.stringMatching(/Sign in once/)])
    expect(readPreflight('Ubuntu', all.replace('HAS_GIT\n', '').replace('HAS_CURL\n', ''))).toMatchObject({ ok: true, notes: [expect.stringMatching(/git/), expect.stringMatching(/curl/)] })
  })
  it('probes the hook server port without curl', () => {
    expect(preflightScript(47821)).toContain('/dev/tcp/127.0.0.1/47821')
  })
})

describe('wslEnvNames', () => {
  it('lists our names once, keeps the existing WSLENV, and drops junk', () => {
    expect(wslEnvNames(['OUROBOROS_HOOK_TOKEN', 'GH_TOKEN', 'bad name', 'GH_TOKEN'], 'FOO/u:OUROBOROS_HOOK_TOKEN')).toBe('FOO/u:OUROBOROS_HOOK_TOKEN:GH_TOKEN')
    expect(WSL_HELPER_ENV).toContain('OUROBOROS_TOKEN')
  })
})

describe('WSL launch', () => {
  it('starts claude in the distro through a login shell with /mnt paths', () => {
    const cmd = buildWslClaudeCommand({ model: 'opus' }, { settingsPath: 'C:\\t\\n1.settings.json', mcpConfigPath: 'C:\\t\\n1.mcp.json', sessionName: 'Builder' }, { distro: 'Ubuntu', cwd: 'C:\\p\\repo' }, 'powershell')
    expect(cmd).toBe(`& wsl.exe -d Ubuntu --cd C:\\p\\repo -e bash -lc "claude --settings /mnt/c/t/n1.settings.json --model opus --mcp-config /mnt/c/t/n1.mcp.json --name Builder"`)
    expect(() => buildWslClaudeCommand({ extraArgs: ['--x', 'a"b'] }, { settingsPath: 'C:\\t\\s.json' }, { distro: 'Ubuntu', cwd: 'C:\\p' }, 'powershell')).toThrow(/double quote/)
    expect(() => buildWslClaudeCommand({}, { settingsPath: 'C:\\t\\s.json' }, { distro: 'Ubuntu', cwd: '\\\\srv\\x' }, 'powershell')).toThrow(/not on a drive/)
  })
  it('turns the sandbox on, uses curl for the status line and starts the Windows MCP server through interop', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ouro-wsl-'))
    const p = prepareLaunch({ nodeId: 'n1', kind: 'claude', claude: {}, shell: 'powershell.exe', baseUrl: 'http://127.0.0.1:47821', token: 't', apiToken: 'a', mailToken: 'm', tmpDir: tmp, execPath: 'C:\\Ouroboros\\Ouroboros.exe', nodeBin: 'C:\\Program Files\\nodejs\\node.exe', mcpScriptPath: 'C:\\app\\mcp.js', wsl: { distro: 'Ubuntu', cwd: 'C:\\p' } })
    const settings = JSON.parse(readFileSync(p.settingsPath!, 'utf8'))
    expect(settings.sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
    expect(settings.statusLine.command).toMatch(/^curl -s/)
    const mcp = JSON.parse(readFileSync(p.mcpConfigPath!, 'utf8'))
    expect(mcp.mcpServers.ouroboros.command).toBe('/mnt/c/Program Files/nodejs/node.exe')
    expect(mcp.mcpServers.ouroboros.args).toEqual(['C:\\app\\mcp.js'])
    expect(p.command).toMatch(/^& wsl\.exe -d Ubuntu --cd /)
  })
  it('points the gate at the Windows node through interop', () => {
    expect(buildGateCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\app\\agent-hook.js', 'http://127.0.0.1:1', 'n1', true)).toBe('"/mnt/c/Program Files/nodejs/node.exe" "C:/app/agent-hook.js" gate --url http://127.0.0.1:1 --node n1')
  })
})
