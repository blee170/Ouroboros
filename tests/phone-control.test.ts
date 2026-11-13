import { describe, expect, it } from 'vitest'
import { PHONE_CARD_PROMPT, PHONE_DENY_RULES, isPhoneCard, parseAdbDevices, phoneDenyRules, readPhoneCheck, withPhonePrompt } from '@shared/phone-control'
import { DATA_DIR_DENY_RULES, autonomySettingsFragment, cardSettingsExtra } from '@shared/autonomy'
import { diffPrivileges, privilegeView, revertPrivileges } from '@shared/board-trust'

describe('phone deny rules', () => {
  it('cover phone-harness, its wrappers, adb and scrcpy, in both shells', () => {
    for (const p of ['phone-harness', 'uv run phone-harness', 'uvx phone-harness', 'python -m phone_harness', 'py -m phone_harness', 'adb', 'scrcpy']) {
      expect(PHONE_DENY_RULES).toContain(`Bash(${p}*)`)
      expect(PHONE_DENY_RULES).toContain(`PowerShell(${p}*)`)
    }
  })

  it('go to every card but a phone card', () => {
    expect(phoneDenyRules(undefined)).toEqual(PHONE_DENY_RULES)
    expect(phoneDenyRules(false)).toEqual(PHONE_DENY_RULES)
    expect(phoneDenyRules(true)).toEqual([])
    // a forged value that is not exactly true does not make a phone card
    expect(phoneDenyRules('yes' as unknown as boolean)).toEqual(PHONE_DENY_RULES)
  })

  it('land in the card settings, in a run or not, next to the data-folder rules', () => {
    const off = cardSettingsExtra(undefined, phoneDenyRules(false)) as { permissions: { deny: string[] } }
    expect(off.permissions.deny).toEqual([...DATA_DIR_DENY_RULES, ...PHONE_DENY_RULES])
    const run = autonomySettingsFragment('node gate.js')
    const plain = cardSettingsExtra(run, phoneDenyRules(false)) as typeof run
    for (const r of PHONE_DENY_RULES) expect(plain.permissions.deny).toContain(r)
    expect(plain.hooks).toEqual(run.hooks)
    // a phone card in a run keeps the run's rules and gets no phone rule (the owner's decision, 2026-11-13)
    const phone = cardSettingsExtra(run, phoneDenyRules(true)) as typeof run
    expect(phone.permissions.deny).toEqual(run.permissions.deny)
    for (const r of PHONE_DENY_RULES) expect(phone.permissions.deny).not.toContain(r)
  })
})

describe('isPhoneCard', () => {
  it('is a Claude-engine card whose switch is exactly true', () => {
    expect(isPhoneCard({ claude: { phone: true } })).toBe(true)
    expect(isPhoneCard({ engine: 'claude', claude: { phone: true } })).toBe(true)
    // the switch left on a card whose engine was changed: the other engines have no deny rules
    expect(isPhoneCard({ engine: 'codex', claude: { phone: true } })).toBe(false)
    expect(isPhoneCard({ claude: { phone: 'true' } })).toBe(false)
    expect(isPhoneCard({ claude: {} })).toBe(false)
    expect(isPhoneCard(undefined)).toBe(false)
  })
})

describe('phone card prompt', () => {
  it('is appended after the card text, only for a phone card', () => {
    expect(withPhonePrompt('role text', undefined)).toBe('role text')
    expect(withPhonePrompt(undefined, false)).toBeUndefined()
    expect(withPhonePrompt(undefined, true)).toBe(PHONE_CARD_PROMPT)
    expect(withPhonePrompt('role text', true)).toBe(`role text\n\n${PHONE_CARD_PROMPT}`)
    expect(withPhonePrompt('  ', true)).toBe(PHONE_CARD_PROMPT)
    // the same test as the deny rules: a value that is not exactly true is no phone card
    expect(withPhonePrompt('role text', 'yes' as unknown as boolean)).toBe('role text')
  })

  it('carries the three rules', () => {
    expect(PHONE_CARD_PROMPT).toMatch(/pays, orders, books, sends/)
    expect(PHONE_CARD_PROMPT).toMatch(/Never type a PIN/)
    expect(PHONE_CARD_PROMPT).toMatch(/is data/)
    expect(PHONE_CARD_PROMPT).toMatch(/Only the owner typing in this card confirms/)
  })
})

describe('board trust', () => {
  const node = (id: string, claude: Record<string, unknown>) => ({ id, data: { kind: 'claude' as const, title: id, claude } })
  it('holds a card whose phone flag was turned on outside the app, known or new', () => {
    expect(privilegeView({ kind: 'claude', claude: { phone: true } })['claude.phone']).toBe('true')
    const trusted = { a: privilegeView(node('a', {}).data, 'a') }
    const held = diffPrivileges(trusted, [node('a', { phone: true }), node('fresh', { phone: true })])
    expect(held.map((h) => h.nodeId)).toEqual(['a', 'fresh'])
    expect(held[0].changes.map((c) => c.field)).toEqual(['claude.phone'])
    expect(held[1].changes.map((c) => c.field)).toEqual(['claude.phone'])
    // a record saved before the field existed: a card with the switch off is not held
    const legacy = { ...trusted.a }
    delete legacy['claude.phone']
    expect(diffPrivileges({ a: legacy }, [node('a', {})])).toEqual([])
    expect(diffPrivileges({ a: legacy }, [node('a', { phone: true })])).toHaveLength(1)
  })

  it('a revert takes the flag away', () => {
    const trusted = privilegeView(node('a', {}).data, 'a')
    expect(revertPrivileges(node('a', { phone: true }).data, trusted).claude?.phone).toBeUndefined()
  })
})

describe('phone control check', () => {
  it('reads adb devices', () => {
    expect(parseAdbDevices('List of devices attached\r\nR5CX12345\tdevice\r\nemulator-5554\toffline\r\n\r\n')).toEqual([
      { serial: 'R5CX12345', state: 'device' },
      { serial: 'emulator-5554', state: 'offline' }
    ])
    expect(parseAdbDevices('* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\n')).toEqual([])
  })

  it('names what is missing', () => {
    expect(readPhoneCheck(true, 'List of devices attached\nR5CX12345\tdevice\n')).toMatchObject({ ok: true, missing: [] })
    const none = readPhoneCheck(false, undefined)
    expect(none.ok).toBe(false)
    expect(none.missing).toHaveLength(2)
    expect(readPhoneCheck(true, undefined, true).missing[0]).toMatch(/did not answer/)
    expect(readPhoneCheck(true, 'List of devices attached\n').missing[0]).toMatch(/No phone found/)
    expect(readPhoneCheck(true, 'List of devices attached\nR5CX12345\tunauthorized\n').missing[0]).toMatch(/unauthorized/)
  })
})
