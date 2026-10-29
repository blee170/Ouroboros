import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useBoard } from '@/store/board'
import type { AppInfo, GitHubCardTokenStatus, GitHubProtectionResult, UpdateStatus } from '@shared/protocol'
import type { WslCheck } from '@shared/wsl'
import { PROTECT_RULES, protectedFully } from '@shared/rulesets'
import { EnginesPanel } from './EnginesPanel'
import { PhoneSettings } from './PhoneSettings'
import { OuroSettings } from './OuroSettings'
import { GrokBotsSettings } from './GrokBotsSettings'
import { GrokReplySettings } from './GrokReplySettings'
import { VoiceSettings } from './VoiceSettings'
import { announceSettings } from '@shared/announce'
import { DEFAULT_STALL_MINUTES } from '@shared/watchdog'
import { RELAY_DEFAULTS, type RelayMode } from '@shared/relay'
import { DEFAULT_STYLE, TTS_ENGINES, ttsSettings, type TtsEngine } from '@shared/tts'
import { notionDatabaseId } from '@shared/notion'
import type { TtsKeyEngine } from '@shared/protocol'
import { speak, voiceFor } from '@/lib/speak'
import { Icon } from '@/lib/icons'
import { useEscape } from '@/lib/useDialog'

const NO_KEYS: Record<TtsKeyEngine, boolean> = { gemini: false, openai: false, elevenlabs: false }

const GROUPS = ['General', 'Voice & phone', 'Integrations', 'Advanced'] as const
const SECTIONS = [
  { id: 'engines', label: 'Engines', group: 'General' },
  { id: 'window', label: 'Window & sessions', group: 'General' },
  { id: 'announce', label: 'Announcements', group: 'General' },
  { id: 'voice', label: 'Voice input', group: 'Voice & phone' },
  { id: 'phone', label: 'Phone', group: 'Voice & phone' },
  { id: 'ouro', label: 'Ouro (Discord)', group: 'Voice & phone' },
  { id: 'github', label: 'GitHub', group: 'Integrations' },
  { id: 'notion', label: 'Notion', group: 'Integrations' },
  { id: 'obsidian', label: 'Obsidian', group: 'Integrations' },
  { id: 'grok', label: 'Grok Bot', group: 'Integrations' },
  { id: 'wsl', label: 'WSL2 cards', group: 'Advanced' },
  { id: 'updates', label: 'Updates', group: 'Advanced' },
  { id: 'about', label: 'About', group: 'Advanced' }
] as const satisfies readonly { id: string; label: string; group: (typeof GROUPS)[number] }[]
type SectionId = (typeof SECTIONS)[number]['id']
// reopening Settings lands on the section used last (for as long as the app runs)
let lastSection: SectionId = 'engines'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useBoard((s) => s.settings)
  const setSettings = useBoard((s) => s.setSettings)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [msg, setMsg] = useState('')
  const [upd, setUpd] = useState<UpdateStatus | null>(null)
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const announce = announceSettings(settings)
  const tts = ttsSettings(settings)
  const [ttsKeys, setTtsKeys] = useState(NO_KEYS)
  const [ttsKey, setTtsKey] = useState('')
  const [notion, setNotion] = useState<{ hasToken: boolean }>({ hasToken: false })
  const [notionToken, setNotionToken] = useState('')
  const [protection, setProtection] = useState<GitHubProtectionResult | null>(null)
  const [confirmProtect, setConfirmProtect] = useState(false)
  const [cardToken, setCardToken] = useState('')
  const [cardTokenStatus, setCardTokenStatus] = useState<GitHubCardTokenStatus>({ hasToken: false })
  const [wslCheck, setWslCheck] = useState<WslCheck | 'checking' | null>(null)
  useEscape(onClose)
  useEffect(() => {
    void window.ouroboros.app.info().then((i) => {
      setInfo(i)
      setHasToken(Boolean(i.hasUpdateToken))
    })
    void window.ouroboros.tts.keys().then(setTtsKeys)
    void window.ouroboros.notion.status().then((n) => setNotion({ hasToken: n.hasToken }))
    void window.ouroboros.github.cardTokenStatus().then(setCardTokenStatus)
    return window.ouroboros.update.onStatus(setUpd)
  }, [])
  const saveTtsKey = async (engine: TtsKeyEngine): Promise<void> => {
    const r = await window.ouroboros.tts.setKey(engine, ttsKey)
    setTtsKeys((k) => ({ ...k, [engine]: r.hasKey }))
    setTtsKey('')
    setMsg(r.hasKey ? `${TTS_ENGINES[engine].label} key saved (encrypted). Press Test.` : 'Key cleared.')
  }
  const testVoice = async (): Promise<void> => {
    const ko = tts.engine !== 'windows' || Boolean(voiceFor('ko'))
    setMsg(tts.engine === 'windows' ? '' : 'Fetching the test sentence…')
    const err = await speak({ kind: 'finished', title: ko ? '총괄' : 'Conductor', lang: ko ? 'ko' : 'en' })
    setMsg(err ? `${err} — the Windows voice spoke instead.` : tts.engine === 'windows' ? '' : 'Spoken with the chosen engine.')
  }
  const saveNotionToken = async (): Promise<void> => {
    const r = await window.ouroboros.notion.setToken(notionToken)
    setNotion((n) => ({ ...n, hasToken: r.hasToken }))
    setNotionToken('')
    setMsg(r.hasToken ? 'Notion token saved (encrypted). Paste the Reports database URL and press Test.' : 'Notion token cleared.')
  }
  const checkProtection = async (): Promise<void> => {
    setProtection(null)
    setConfirmProtect(false)
    setProtection(await window.ouroboros.github.protection())
  }
  const protectMain = async (): Promise<void> => {
    setConfirmProtect(false)
    setMsg('Adding the ruleset on GitHub…')
    const r = await window.ouroboros.github.protect()
    setProtection(r)
    setMsg(r.ok ? (r.added ? `GitHub: ${r.repo} ${r.branch} is now protected.` : `GitHub: ${r.repo} ${r.branch} was already protected; nothing sent.`) : `GitHub: ${r.error}`)
  }
  const saveCardToken = async (): Promise<void> => {
    if (cardToken && !cardToken.trim()) {
      setCardToken('')
      setMsg('Card token: nothing to save (the field held only spaces).')
      return
    }
    const r = await window.ouroboros.github.setCardToken(cardToken)
    setCardToken('')
    setCardTokenStatus(r)
    setMsg(r.hasToken ? 'Card token saved (encrypted). Cards started from now on use it; press Check.' : 'Card token cleared: cards use your own gh and git sign-in again.')
  }
  const checkCardToken = async (): Promise<void> => {
    setMsg('Asking GitHub…')
    const r = await window.ouroboros.github.cardTokenStatus(true)
    setCardTokenStatus(r)
    setMsg(r.error ? `Card token: ${r.error}` : `Card token: belongs to ${r.login}${r.expiresAt ? `, expires ${r.expiresAt}` : ', no expiry'}.`)
  }
  const checkWsl = async (): Promise<void> => {
    setWslCheck('checking')
    setWslCheck(await window.ouroboros.wsl.check())
  }
  const saveNotionDb = (value: string, field: 'notionDatabaseId' | 'notionTasksDatabaseId' | 'notionUpdatesDatabaseId' = 'notionDatabaseId'): void => {
    const id = notionDatabaseId(value)
    const raw = value.trim()
    void setSettings({ [field]: id ?? (raw || undefined) })
    if (raw && !id) setMsg('That does not look like a Notion database URL or id (32 hex characters expected).')
  }
  const exportToVault = async (): Promise<void> => {
    setMsg('Writing to the vault…')
    const r = await window.ouroboros.obsidian.exportNow()
    setMsg(r.ok ? `Obsidian: ${r.folder ?? 'the vault'} — ${r.written} written, ${r.removed} removed${r.kept ? `, ${r.kept} kept as you edited them` : ''}.` : `Obsidian: ${r.error ?? 'export failed'}`)
  }
  const testNotion = async (which: 'reports' | 'tasks' | 'updates' = 'reports'): Promise<void> => {
    setMsg('Asking Notion…')
    const r = await window.ouroboros.notion.test(which)
    const what = which === 'tasks' ? 'Tasks will be kept in sync there' : which === 'updates' ? 'Release notes will go there on the next new version' : 'Reports will be published there'
    setMsg(r.ok ? `Notion: found database "${r.title}". ${what}.` : `Notion: ${r.error}`)
  }
  const [addingViews, setAddingViews] = useState(false)
  const addNotionViews = async (): Promise<void> => {
    setAddingViews(true)
    setMsg('Adding views in Notion…')
    try {
      const r = await window.ouroboros.notion.addViews()
      setMsg(`Notion views — ${r.lines.join(' · ')}`)
    } finally {
      setAddingViews(false)
    }
  }
  const saveToken = async (): Promise<void> => {
    const r = await window.ouroboros.update.setToken(token)
    setHasToken(r.hasToken)
    setToken('')
    setMsg(r.hasToken ? 'Token saved (encrypted).' : 'Token cleared.')
  }

  const toggleExternal = async (enable: boolean): Promise<void> => {
    const r = await window.ouroboros.external.installHooks(enable)
    if (!r.ok) {
      setMsg(`Failed: ${r.error}`)
      return
    }
    await setSettings({ trackExternalSessions: enable })
    setMsg(enable ? 'Global hook written to ~/.claude/settings.json. New Claude Code sessions started anywhere will appear as external cards.' : 'Global hook removed.')
  }

  // every section stays mounted (a half-typed token survives a section switch); the search reads the rendered text,
  // hints and placeholders included, so a new setting is findable without a keyword list
  const [section, setSection] = useState<SectionId>(lastSection)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SectionId[] | null>(null)
  const paneEls = useRef(new Map<SectionId, HTMLElement>())
  useLayoutEffect(() => {
    const q = query.trim().toLowerCase()
    if (!q) return setMatches(null)
    const text = (s: (typeof SECTIONS)[number]): string => {
      const el = paneEls.current.get(s.id)
      if (!el) return '' // not rendered yet (About before the app info arrives): nothing to show
      const placeholders = [...el.querySelectorAll('[placeholder]')].map((p) => p.getAttribute('placeholder')).join(' ')
      return `${s.label} ${el.textContent ?? ''} ${placeholders}`.toLowerCase()
    }
    setMatches(SECTIONS.filter((s) => text(s).includes(q)).map((s) => s.id))
  }, [query])
  const bodyEl = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (bodyEl.current) bodyEl.current.scrollTop = 0
  }, [section, matches])
  const pick = (id: SectionId): void => {
    lastSection = id
    setSection(id)
    setQuery('')
  }
  const pane = (id: SectionId) => ({
    ref: (el: HTMLElement | null) => {
      if (el) paneEls.current.set(id, el)
      else paneEls.current.delete(id)
    },
    hidden: matches ? !matches.includes(id) : id !== section
  })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings" role="dialog" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="settings-title">
          <Icon name="settings" /> Settings
        </h3>
        <div className="settings-layout">
          <nav className="settings-nav">
            <div className="settings-search">
              <Icon name="search" size={13} />
              <input
                className="text"
                placeholder="Search settings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // the first Escape clears the search, the next one closes the dialog
                  if (e.key === 'Escape' && query) {
                    e.preventDefault()
                    setQuery('')
                  }
                }}
              />
            </div>
            {GROUPS.map((g) => {
              const items = SECTIONS.filter((s) => s.group === g && (!matches || matches.includes(s.id)))
              return (
                items.length > 0 && (
                  <div key={g} className="settings-group">
                    <div className="settings-group-label">{g}</div>
                    {items.map((s) => (
                      <button
                        key={s.id}
                        className={`settings-nav-item${!matches && s.id === section ? ' active' : ''}`}
                        aria-current={!matches && s.id === section ? 'page' : undefined}
                        onClick={() => pick(s.id)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )
              )
            })}
          </nav>
          <div ref={bodyEl} className={`settings-body${matches ? ' searching' : ''}`}>
            {matches?.length === 0 && <div className="hint">Nothing matches "{query.trim()}".</div>}

            <section className="settings-section" {...pane('engines')}>
              <h4>Engines</h4>
              <EnginesPanel />
            </section>

            <section className="settings-section" {...pane('window')}>
              <h4>Window &amp; sessions</h4>
              <label className="check">
                <input type="checkbox" checked={settings.minimizeToTray} onChange={(e) => void setSettings({ minimizeToTray: e.target.checked })} /> Keep running in the tray when the window is closed
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.trackExternalSessions} onChange={(e) => void toggleExternal(e.target.checked)} /> Track Claude Code sessions started outside Ouroboros
              </label>
              <div className="hint">Writes a hook into your user settings; those sessions appear as external cards in their project's window.</div>
              <label className="check">
                <input type="checkbox" checked={settings.claudeLinksExternal === true} onChange={(e) => void setSettings({ claudeLinksExternal: e.target.checked })} /> Open claude.ai briefs in the system browser instead of a browser card
              </label>
              <div className="hint">Only if claude.ai refuses to sign in inside the card; the card's open-in-browser button does the same per page.</div>
              <label className="check">
                <input type="checkbox" checked={settings.keepEnvApiKey === true} onChange={(e) => void setSettings({ keepEnvApiKey: e.target.checked })} /> Let an ANTHROPIC_API_KEY in the environment override my Claude sign-in
              </label>
              <div className="hint">Off: while <code>claude</code> is signed in, Claude cards do not inherit ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (a stale key there makes every turn fail with "Invalid API key"). A key for a gateway (ANTHROPIC_BASE_URL set) and a key set in Claude's own settings or your shell profile are left alone. Takes effect for cards launched after the change.</div>
              <label className="check">
                <input type="checkbox" checked={settings.passCredentialEnv === true} onChange={(e) => void setSettings({ passCredentialEnv: e.target.checked })} /> Pass my credential variables (GITHUB_TOKEN, SUPABASE_ACCESS_TOKEN, …) to agent cards
              </label>
              <div className="hint">Off: agent cards do not inherit deploy, database and cloud tokens from the environment, nor the other engines' API keys, so a card that is talked into printing its environment has none to leak. gh, git and the Supabase CLI keep working through the Windows keyring. Terminal cards are your own shell and keep everything. Takes effect for cards launched after the change.</div>
              <label className="field">
                <span>Browser home</span>
                <div className="ctl">
                  <input className="text" placeholder="https://www.google.com" defaultValue={settings.browserHome ?? ''} onBlur={(e) => void setSettings({ browserHome: e.target.value.trim() || undefined })} />
                </div>
              </label>
              <label className="field">
                <span>Default shell</span>
                <div className="ctl">
                  <input className="text" placeholder={info?.platform === 'win32' ? 'powershell.exe' : '$SHELL'} defaultValue={settings.defaultShell ?? ''} onBlur={(e) => void setSettings({ defaultShell: e.target.value.trim() || undefined })} />
                </div>
              </label>
            </section>

            <section className="settings-section" {...pane('announce')}>
              <h4>Announcements</h4>
              <label className="check">
                <input type="checkbox" checked={settings.notifications} onChange={(e) => void setSettings({ notifications: e.target.checked })} /> Desktop notification when a card needs you
              </label>
              <label className="field">
                <span>Stall alert</span>
                <div className="ctl">
                  <input className="text" style={{ width: 80, flex: 'none' }} type="number" min={0} max={240} defaultValue={settings.stallMinutes ?? DEFAULT_STALL_MINUTES} onBlur={(e) => void setSettings({ stallMinutes: Math.min(240, Math.max(0, Number(e.target.value) | 0)) })} />
                  <span className="small">min</span>
                </div>
                <div className="hint">A card Working with no activity (three times as long inside a tool call), or waiting on you, this long is reported to its Conductor; the third report, or a card with no Conductor, notifies you. 0 = off. Autonomous mode has its own stall rule.</div>
              </label>
              <label className="field">
                <span>Fresh start</span>
                <div className="ctl">
                  <input className="text" style={{ width: 80, flex: 'none' }} type="number" min={50} max={900} defaultValue={Math.round((settings.relayTokens ?? RELAY_DEFAULTS.tokens) / 1000)} onBlur={(e) => {
                      // an emptied field keeps the setting: it would otherwise drop to the 50k floor
                      const k = Number(e.target.value)
                      if (e.target.value.trim() && Number.isFinite(k)) void setSettings({ relayTokens: Math.min(900, Math.max(50, Math.round(k))) * 1000 })
                    }} aria-label="Fresh start threshold in thousands of tokens" />
                  <span className="small">k tokens · Conductor</span>
                  <select value={settings.relayConductor ?? RELAY_DEFAULTS.conductor} onChange={(e) => void setSettings({ relayConductor: e.target.value as RelayMode })} aria-label="Fresh start for Conductors">
                    <option value="ask">ask me</option>
                    <option value="auto">automatic</option>
                    <option value="off">off</option>
                  </select>
                  <span className="small">workers</span>
                  <select value={settings.relayWorkers ?? RELAY_DEFAULTS.workers} onChange={(e) => void setSettings({ relayWorkers: e.target.value as RelayMode })} aria-label="Fresh start for worker cards">
                    <option value="auto">automatic</option>
                    <option value="ask">ask me</option>
                    <option value="off">off</option>
                  </select>
                </div>
                <div className="hint">An idle Claude card whose conversation passes this size (never more than 60% of its window) writes a handoff note, is cleared with /clear, and continues from the note. Its tasks and board stay. At most 3 per card in 12 h. &quot;Ask me&quot; puts the question in Today, on the phone and in Discord.</div>
              </label>
              <label className="field">
                <span>Announce</span>
                <div className="ctl">
                  <select value={announce.target} onChange={(e) => void setSettings({ announce: e.target.value as 'off' | 'conductor' | 'all' })}>
                    <option value="off">nothing</option>
                    <option value="conductor">Conductor replies</option>
                    <option value="all">every card's replies</option>
                  </select>
                </div>
              </label>
              <label className="field">
                <span>When</span>
                <div className="ctl">
                  <select value={announce.mode} onChange={(e) => void setSettings({ announceMode: e.target.value as 'important' | 'every' })}>
                    <option value="important">decisions and reports only</option>
                    <option value="every">every reply</option>
                  </select>
                </div>
                <div className="hint">
                  Decisions and reports: a reply ending in an OWNER: DECIDE or OWNER: REPORT line (the Conductor is told to add one), a report link, or a task blocked on your approval. Every reply: any turn of 10 s or more, and "all cards have finished". A card waiting on you is always announced; the reply itself is never read out.
                </div>
              </label>
              <label className="check">
                <input type="checkbox" checked={announce.toast} onChange={(e) => void setSettings({ announceToast: e.target.checked })} /> Desktop toast with the first line of the reply
              </label>
              <label className="check">
                <input type="checkbox" checked={announce.voice} onChange={(e) => void setSettings({ announceVoice: e.target.checked })} /> Speak it
                <button className="btn small" onClick={() => void testVoice()}>
                  <Icon name="volume" size={13} /> Test
                </button>
              </label>
              <label className="field">
                <span>Voice engine</span>
                <div className="ctl">
                  <select
                    value={tts.engine}
                    onChange={(e) => {
                      setTtsKey('')
                      void setSettings({ ttsEngine: e.target.value as TtsEngine, ttsVoice: undefined })
                    }}
                  >
                    {(Object.keys(TTS_ENGINES) as TtsEngine[]).map((e) => (
                      <option key={e} value={e}>
                        {TTS_ENGINES[e].label}
                      </option>
                    ))}
                  </select>
                </div>
                {tts.engine === 'windows' && <div className="hint">{voiceFor('ko') ? 'Korean voice installed (Heami).' : 'No Korean voice installed: English only.'}</div>}
              </label>
              {tts.engine !== 'windows' && (
                <>
                  {tts.engine !== 'voicebox' && (
                    <label className="field">
                      <span>API key</span>
                      <div className="ctl">
                        <input className="text" type="password" placeholder={ttsKeys[tts.engine] ? '•••••• (saved)' : TTS_ENGINES[tts.engine].keyHint} value={ttsKey} onChange={(e) => setTtsKey(e.target.value)} />
                        <button className="btn" onClick={() => void saveTtsKey(tts.engine as TtsKeyEngine)}>
                          {ttsKey ? 'Save' : ttsKeys[tts.engine] ? 'Clear' : 'Save'}
                        </button>
                      </div>
                    </label>
                  )}
                  <label className="field">
                    <span>Voice</span>
                    <div className="ctl">
                      <input key={tts.engine} className="text" placeholder={TTS_ENGINES[tts.engine].defaultVoice} defaultValue={settings.ttsVoice ?? ''} onBlur={(e) => void setSettings({ ttsVoice: e.target.value.trim() || undefined })} />
                    </div>
                    <div className="hint">{TTS_ENGINES[tts.engine].voiceHint}</div>
                  </label>
                  {tts.engine !== 'elevenlabs' && tts.engine !== 'voicebox' && (
                    <label className="field">
                      <span>Style</span>
                      <div className="ctl">
                        <input className="text" placeholder={tts.engine === 'gemini' ? 'empty = steadiest' : DEFAULT_STYLE} defaultValue={settings.ttsStyle ?? ''} onBlur={(e) => void setSettings({ ttsStyle: e.target.value.trim() || undefined })} />
                      </div>
                      {tts.engine === 'gemini' && <div className="hint">Leave it empty for the same voice every time, or one short phrase (“calm”). A language, accent, age or gender here makes Gemini drift between sentences; the language comes from the text itself.</div>}
                    </label>
                  )}
                  <div className="hint">
                    {tts.engine === 'voicebox'
                      ? 'Voicebox runs on this PC (voicebox.sh, free): clone your voice there, then put the profile name above (as in its left column). Keep the Voicebox app open; nothing leaves the PC. Speed is Voicebox\'s: a cloned voice on its CPU backend takes up to a minute per sentence (switch Voicebox to its GPU backend in its own Settings), Kokoro presets a few seconds. Ouroboros waits up to 2 minutes; if Voicebox is not running, the Windows voice speaks instead.'
                      : "Your own subscription: the key is stored encrypted and sent only to that engine. Each sentence is fetched once and kept under the app's data folder; if the engine fails, the Windows voice speaks instead."}
                  </div>
                </>
              )}
              <div className="hint">
                Voice input: in a Claude card type <code>/voice</code> (or <code>/voice tap</code>), then hold or tap Space and speak — Claude Code's own dictation, Korean included, with a claude.ai sign-in.
              </div>
            </section>

            <div {...pane('voice')}>
              <VoiceSettings />
            </div>

            <div {...pane('phone')}>
              <PhoneSettings />
            </div>

            <div {...pane('ouro')}>
              <OuroSettings />
            </div>

            <section className="settings-section" {...pane('github')}>
              <h4>GitHub</h4>
              <label className="field">
                <span>Protect main</span>
                <div className="ctl">
                  <button className="btn" onClick={() => void checkProtection()} title="Reads the rules active on the open project's default branch with your gh sign-in">
                    Check
                  </button>
                  {protection?.ok && !protectedFully(protection) && !confirmProtect && (
                    <button className="btn" onClick={() => setConfirmProtect(true)}>
                      Protect {protection.repo}…
                    </button>
                  )}
                  {confirmProtect && (
                    <>
                      <button className="btn primary" onClick={() => void protectMain()}>
                        Add ruleset
                      </button>
                      <button className="btn" onClick={() => setConfirmProtect(false)}>
                        Cancel
                      </button>
                    </>
                  )}
                </div>
                <div className="hint">
                  {protection === null
                    ? "The open project's default branch on GitHub: whether it needs a pull request and refuses force pushes and deletion. This is the rail a card cannot get around with local credentials."
                    : protection.ok
                      ? `${protection.repo} · ${protection.branch}${protection.private ? ' (private)' : ''}: ${PROTECT_RULES.map((r) => `${protection.rules[r] ? '✓' : '✗'} ${r === 'pull_request' ? 'pull request required' : r === 'non_fast_forward' ? 'no force push' : 'no deletion'}`).join(' · ')}`
                      : protection.error}
                  {confirmProtect && ' Adds one ruleset, "Ouroboros · protect main", on the default branch: a pull request is required (0 approvals, so you can merge your own), force pushes and deletion are refused, and nobody bypasses it, you included: pushing straight to main stops working, merging a pull request does not. It does not stop a pull request being merged by anyone who can push, a card token included: during autonomous runs the action gate asks you before gh pr merge, but a merge through the API (curl) is not seen. Change or remove it on GitHub under Settings → Rules.'}
                </div>
              </label>
              <label className="field">
                <span>Card token</span>
                <div className="ctl">
                  <input className="text" type="password" placeholder={cardTokenStatus.hasToken ? '•••••• (saved)' : 'github_pat_…'} value={cardToken} onChange={(e) => setCardToken(e.target.value)} />
                  <button className="btn" onClick={() => void saveCardToken()}>
                    {cardToken ? 'Save' : cardTokenStatus.hasToken ? 'Clear' : 'Save'}
                  </button>
                  <button className="btn" disabled={!cardTokenStatus.hasToken} onClick={() => void checkCardToken()}>
                    Check
                  </button>
                </div>
                <div className="hint">
                  A fine-grained token only for agent cards: make one on GitHub (Settings → Developer settings → Fine-grained tokens) for the repositories cards work in, with an expiry, Contents and Pull requests read and write, nothing else. With it saved, agent cards started from then on use it for gh and git push instead of your sign-in, so a card can push its branches and open pull requests and the ruleset above stops it at main. Stored encrypted. Your terminal cards keep your own sign-in, and without a saved token agent cards use it too. Only https remotes use the token: a git@github.com remote pushes with your SSH key.
                </div>
              </label>
            </section>

            <section className="settings-section" {...pane('notion')}>
              <h4>Notion</h4>
              <label className="check">
                <input type="checkbox" checked={settings.notionPublish === true} onChange={(e) => void setSettings({ notionPublish: e.target.checked })} /> Publish to Notion: morning reports, the task list and release notes
              </label>
              <div className="hint">
                One row per run in your <em>Ouroboros → Reports</em> database, the report as the page. Needs an internal integration (notion.so/profile/integrations → New integration, read + insert content) and the Reports database shared with it (⋯ → Connections). The note on the canvas and the report file are written first; a failed publish is a toast and a line in the run log, never a lost report.
              </div>
              <label className="field">
                <span>Integration token</span>
                <div className="ctl">
                  <input className="text" type="password" placeholder={notion.hasToken ? '•••••• (saved)' : 'ntn_…'} value={notionToken} onChange={(e) => setNotionToken(e.target.value)} />
                  <button className="btn" onClick={() => void saveNotionToken()}>
                    {notionToken ? 'Save' : notion.hasToken ? 'Clear' : 'Save'}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Reports database</span>
                <div className="ctl">
                  <input className="text" placeholder="paste the database URL or id" defaultValue={settings.notionDatabaseId ?? ''} onBlur={(e) => saveNotionDb(e.target.value)} />
                  <button className="btn" onClick={() => void testNotion()}>
                    Test
                  </button>
                </div>
                <div className="hint">Test fetches the database with the saved token (stored encrypted, sent only to api.notion.com).</div>
              </label>
              <label className="field">
                <span>Tasks database</span>
                <div className="ctl">
                  <input className="text" placeholder="optional: the Tasks database URL" defaultValue={settings.notionTasksDatabaseId ?? ''} onBlur={(e) => saveNotionDb(e.target.value, 'notionTasksDatabaseId')} />
                  <button className="btn" onClick={() => void testNotion('tasks')}>
                    Test
                  </button>
                </div>
                <div className="hint">Every task of the open project's ledger as a row (Task ID, State, Owner, Result, Reason), updated a few seconds after it changes. Rows deleted in Notion come back at the task's next change.</div>
              </label>
              <label className="field">
                <span>Updates database</span>
                <div className="ctl">
                  <input className="text" placeholder="optional: the Updates database URL" defaultValue={settings.notionUpdatesDatabaseId ?? ''} onBlur={(e) => saveNotionDb(e.target.value, 'notionUpdatesDatabaseId')} />
                  <button className="btn" onClick={() => void testNotion('updates')}>
                    Test
                  </button>
                </div>
                <div className="hint">On the first start of each new version, its release notes (from the changelog) as one page.</div>
              </label>
              <label className="field">
                <span>Views</span>
                <div className="ctl">
                  <button className="btn" onClick={() => void addNotionViews()} disabled={addingViews}>
                    Add views
                  </button>
                </div>
                <div className="hint">Adds Ouroboros views to the databases above: Tasks as a board by state and a "Waiting on you" table, Reports as a calendar, Updates newest first. Views already there (by name) are left alone; the integration needs the insert and update content capabilities.</div>
              </label>
            </section>

            <section className="settings-section" {...pane('obsidian')}>
              <h4>Obsidian</h4>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.obsidianExport === true}
                  onChange={(e) => {
                    const on = e.target.checked
                    // the first export runs once main has the switch on
                    void Promise.resolve(setSettings({ obsidianExport: on })).then(() => {
                      if (on && settings.obsidianVaultPath) void exportToVault()
                    })
                  }}
                />{' '}
                Mirror this project into my Obsidian vault: tasks, morning reports and the board
              </label>
              <div className="hint">
                Written under <em>Ouroboros/&lt;project&gt;/</em> in the vault, a few seconds after tasks or cards change: one note per task (state, owner, links to its parent and dependencies), the morning reports, a <em>Board.canvas</em>, a <em>Tasks.base</em> table and a home note. One-way: a file you edit in Obsidian is kept and no longer updated; nothing outside that folder is touched.
              </div>
              <label className="field">
                <span>Vault folder</span>
                <div className="ctl">
                  <input className="text mono" readOnly placeholder="choose your vault folder" value={settings.obsidianVaultPath ?? ''} />
                  <button
                    className="btn"
                    onClick={() =>
                      void window.ouroboros.obsidian.pick().then((p) => {
                        if (p) void setSettings({ obsidianVaultPath: p })
                      })
                    }
                  >
                    Choose…
                  </button>
                  <button className="btn" onClick={() => void exportToVault()}>
                    Export now
                  </button>
                </div>
              </label>
            </section>

            <section className="settings-section" {...pane('grok')}>
              <h4>Grok Bot</h4>
              <div className="hint">
                Lets a card (usually the Conductor) hand a task to one of your Grok Bots, xAI and Cursor's cloud teammates with their own browser and computer. Make one bot per purpose (for example Personal: email, vendor replies, calendar; Business: marketing research), each with its own instructions and memory. In each bot, make a routine whose instruction says what to do with a handoff ("do the task in the JSON body"), ask the bot to add a webhook trigger, and copy its URL and key here. The Conductor reads each bot's purpose to pick one. Apps you connect in Grok (Gmail, Calendar) are shared by every bot on that account. Every handoff waits for you in the Today tab: nothing is sent until you press <em>Send</em>.
              </div>
              <GrokBotsSettings />
              <GrokReplySettings />
            </section>

            <section className="settings-section" {...pane('wsl')}>
              <h4>WSL2 cards (experimental)</h4>
              <div className="hint">
                A Claude card with <em>Run in WSL2 with the sandbox</em> ticked (Inspector) starts claude inside a Linux distribution with Claude Code's sandbox on: its shell commands can write only in the card's folder and reach only the network you allow. Native Windows has no such sandbox. The card's folder is reached through /mnt/c, which is slower than a Linux folder.
              </div>
              <label className="field">
                <span>Distribution</span>
                <div className="ctl">
                  <input className="text" placeholder="first one found (not Docker Desktop's)" defaultValue={settings.wslDistro ?? ''} onBlur={(e) => void setSettings({ wslDistro: e.target.value.trim() || undefined })} />
                  <button className="btn" disabled={wslCheck === 'checking'} onClick={() => void checkWsl()}>
                    {wslCheck === 'checking' ? 'Checking…' : 'Check'}
                  </button>
                </div>
                {wslCheck && wslCheck !== 'checking' && (
                  <div className="hint">
                    {wslCheck.ok ? `${wslCheck.distro}: ready for WSL cards.` : `${wslCheck.distro ? `${wslCheck.distro}: ` : ''}not ready yet.`}
                    {[...wslCheck.missing, ...wslCheck.notes].map((m) => (
                      <div key={m}>• {m}</div>
                    ))}
                  </div>
                )}
              </label>
            </section>

            <section className="settings-section" {...pane('updates')}>
              <h4>Updates · v{info?.version}</h4>
              <div className="row">
                <button className="btn" disabled={!info?.packaged || upd?.state === 'checking' || upd?.state === 'downloading'} onClick={() => void window.ouroboros.update.check()}>
                  Check for updates
                </button>
                {upd?.state === 'available' && (
                  <button className="btn primary" onClick={() => void window.ouroboros.update.download()}>
                    Download v{upd.version}
                  </button>
                )}
                {upd?.state === 'ready' && (
                  <button className="btn primary" onClick={() => void window.ouroboros.update.install()}>
                    Restart &amp; install v{upd.version}
                  </button>
                )}
                <span className="small muted">
                  {!info?.packaged && 'dev build: git pull + npm run dev'}
                  {upd?.state === 'checking' && 'checking…'}
                  {upd?.state === 'up-to-date' && 'up to date'}
                  {upd?.state === 'downloading' && `downloading ${upd.percent ?? 0}%`}
                  {upd?.state === 'error' && upd.message}
                </span>
              </div>
              <label className="field">
                <span>GitHub token</span>
                <div className="ctl">
                  <input className="text" type="password" placeholder={hasToken ? '•••••• (saved)' : 'fine-grained token, Contents: read on blee170/Ouroboros'} value={token} onChange={(e) => setToken(e.target.value)} />
                  <button className="btn" onClick={() => void saveToken()}>
                    {token ? 'Save' : hasToken ? 'Clear' : 'Save'}
                  </button>
                </div>
                <div className="hint">Releases are built by GitHub Actions on every version bump. The repository is public, so no token is needed; the field is for private forks (stored encrypted).</div>
              </label>
            </section>

            {info && (
              <section className="settings-section" {...pane('about')}>
                <h4>About</h4>
                <div className="hint">
                  Hook server on 127.0.0.1:{info.hookPort}
                  {info.hookPort !== 47821 ? ' (non-default port: external tracking will not work until restarted with 47821 free)' : ''} · data in <code>{info.userData}</code>
                  <br />
                  MCP runner: <code>{info.mcpRunner}</code> → <code>{info.mcpScript}</code>
                  <br />
                  Diagnostics: <code>{info.logFile ?? 'main.log'}</code> (what the app was doing) · crash dumps in <code>{info.crashDir ?? 'Crashpad'}</code>. Attach both when reporting a crash.
                </div>
              </section>
            )}
          </div>
        </div>
        <div className="settings-foot">
          <div className="status">{msg}</div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
