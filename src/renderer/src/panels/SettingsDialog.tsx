import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'
import type { AppInfo, UpdateStatus } from '@shared/protocol'
import { EnginesPanel } from './EnginesPanel'
import { announceSettings } from '@shared/announce'
import { DEFAULT_STALL_MINUTES } from '@shared/watchdog'
import { DEFAULT_STYLE, TTS_ENGINES, ttsSettings, type TtsEngine } from '@shared/tts'
import { notionDatabaseId } from '@shared/notion'
import type { TtsKeyEngine } from '@shared/protocol'
import { speak, voiceFor } from '@/lib/speak'
import { Icon } from '@/lib/icons'
import { useEscape } from '@/lib/useDialog'

const NO_KEYS: Record<TtsKeyEngine, boolean> = { gemini: false, openai: false, elevenlabs: false }

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
  useEscape(onClose)
  useEffect(() => {
    void window.ouroboros.app.info().then((i) => {
      setInfo(i)
      setHasToken(Boolean(i.hasUpdateToken))
    })
    void window.ouroboros.tts.keys().then(setTtsKeys)
    void window.ouroboros.notion.status().then((n) => setNotion({ hasToken: n.hasToken }))
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
  const saveNotionDb = (value: string): void => {
    const id = notionDatabaseId(value)
    const raw = value.trim()
    void setSettings({ notionDatabaseId: id ?? (raw || undefined) })
    if (raw && !id) setMsg('That does not look like a Notion database URL or id (32 hex characters expected).')
  }
  const testNotion = async (): Promise<void> => {
    setMsg('Asking Notion…')
    const r = await window.ouroboros.notion.test()
    setMsg(r.ok ? `Notion: found database "${r.title}". Reports will be published there.` : `Notion: ${r.error}`)
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings" role="dialog" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="settings-title">
          <Icon name="settings" /> Settings
        </h3>

        <section className="settings-section first">
          <h4>Engines</h4>
          <EnginesPanel />
        </section>

        <section className="settings-section">
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
            <span>Announce</span>
            <div className="ctl">
              <select value={announce.target} onChange={(e) => void setSettings({ announce: e.target.value as 'off' | 'conductor' | 'all' })}>
                <option value="off">nothing</option>
                <option value="conductor">Conductor replies</option>
                <option value="all">every card's replies</option>
              </select>
            </div>
            <div className="hint">A turn of 10 s or more; "needs you" and "all cards have finished" are announced too. The reply itself is never read out.</div>
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
              <label className="field">
                <span>API key</span>
                <div className="ctl">
                  <input className="text" type="password" placeholder={ttsKeys[tts.engine] ? '•••••• (saved)' : TTS_ENGINES[tts.engine].keyHint} value={ttsKey} onChange={(e) => setTtsKey(e.target.value)} />
                  <button className="btn" onClick={() => void saveTtsKey(tts.engine as TtsKeyEngine)}>
                    {ttsKey ? 'Save' : ttsKeys[tts.engine] ? 'Clear' : 'Save'}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Voice</span>
                <div className="ctl">
                  <input key={tts.engine} className="text" placeholder={TTS_ENGINES[tts.engine].defaultVoice} defaultValue={settings.ttsVoice ?? ''} onBlur={(e) => void setSettings({ ttsVoice: e.target.value.trim() || undefined })} />
                </div>
                <div className="hint">{TTS_ENGINES[tts.engine].voiceHint}</div>
              </label>
              {tts.engine !== 'elevenlabs' && (
                <label className="field">
                  <span>Style</span>
                  <div className="ctl">
                    <input className="text" placeholder={DEFAULT_STYLE} defaultValue={settings.ttsStyle ?? ''} onBlur={(e) => void setSettings({ ttsStyle: e.target.value.trim() || undefined })} />
                  </div>
                </label>
              )}
              <div className="hint">Your own subscription: the key is stored encrypted and sent only to that engine. Each sentence is fetched once and kept under the app's data folder; if the engine fails, the Windows voice speaks instead.</div>
            </>
          )}
          <div className="hint">
            Voice input: in a Claude card type <code>/voice</code> (or <code>/voice tap</code>), then hold or tap Space and speak — Claude Code's own dictation, Korean included, with a claude.ai sign-in.
          </div>
        </section>

        <section className="settings-section">
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

        <section className="settings-section">
          <h4>Notion</h4>
          <label className="check">
            <input type="checkbox" checked={settings.notionPublish === true} onChange={(e) => void setSettings({ notionPublish: e.target.checked })} /> Publish the morning report of every autonomous run to Notion
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
        </section>

        <section className="settings-section">
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
          <section className="settings-section">
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

        {msg && <div className="status">{msg}</div>}
        <div className="row right">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
