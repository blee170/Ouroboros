import { describe, expect, it } from 'vitest'
import { matchesCondition, renderTemplate, selectHandoffs, toPastePayload } from '@shared/handoff'
import type { WorkspaceEdge } from '@shared/types'

const edges: WorkspaceEdge[] = [
  { id: 'e1', source: 'a', target: 'b', data: { mode: 'auto', template: 'x' } },
  { id: 'e2', source: 'a', target: 'c', data: { mode: 'manual', template: 'y' } },
  { id: 'e3', source: 'a', target: 'd', data: { mode: 'auto', template: 'z', condition: 'READY' } },
  { id: 'e4', source: 'q', target: 'b', data: { mode: 'auto', template: 'w' } }
]

describe('renderTemplate', () => {
  it('substitutes known keys and blanks unknown ones', () => {
    expect(renderTemplate('From {{source_title}}: {{ last_assistant_message }} {{nope}}', { source_title: 'A', last_assistant_message: 'hi' })).toBe('From A: hi ')
  })
})

describe('matchesCondition', () => {
  it('treats empty as always', () => expect(matchesCondition('', 'anything')).toBe(true))
  it('does case-insensitive substring', () => expect(matchesCondition('ready', 'All READY now')).toBe(true))
  it('supports /regex/flags', () => {
    expect(matchesCondition('/^PR #\\d+/m', 'line\nPR #12 opened')).toBe(true)
    expect(matchesCondition('/[/', 'x')).toBe(false)
  })
})

describe('selectHandoffs', () => {
  it('returns only auto edges from the source whose condition matches', () => {
    expect(selectHandoffs(edges, 'a', 'nothing').map((e) => e.id)).toEqual(['e1'])
    expect(selectHandoffs(edges, 'a', 'READY to go').map((e) => e.id)).toEqual(['e1', 'e3'])
  })
  it('can include manual edges', () => {
    expect(selectHandoffs(edges, 'a', 'READY', { includeManual: true }).map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
  })
})

describe('toPastePayload', () => {
  it('wraps in bracketed paste and normalises newlines', () => {
    expect(toPastePayload('a\r\nb\n\n')).toBe('\x1b[200~a\nb\x1b[201~')
  })
  it('drops control characters so the text cannot end the paste early', () => {
    // a hook message carrying the end-of-paste sequence would otherwise type the rest as keys
    expect(toPastePayload('ok\x1b[201~rm -rf .\r\x07\x9b201~')).toBe('\x1b[200~ok[201~rm -rf .\n201~\x1b[201~')
    expect(toPastePayload('a\tb\nc')).toBe('\x1b[200~a\tb\nc\x1b[201~')
  })
})
