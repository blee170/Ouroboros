import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'
import type { AppInfo, UpdateStatus } from '@shared/protocol'
import { EnginesPanel } from './EnginesPanel'
import { announceSettings } from '@shared/announce'
import { DEFAULT_STYLE, TTS_ENGINES, ttsSettings, type TtsEngine } from '@shared/tts'
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
  useEscape(onClose)
  useEffect(() => {
    void window.ouroboros.app.info().then((i) => {
      setInfo(i)
      setHasToken(Boolean(i.hasUpdateToken))
    })
    void window.ouroboros.tts.keys().then(setTtsKeys)
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
          <div className="hint">Only if claude.ai refuses to sign in inside the card; the card's ↗ button does the same per page.</div>
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
