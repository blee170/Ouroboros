import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'
import type { AppInfo, UpdateStatus } from '@shared/protocol'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useBoard((s) => s.settings)
  const setSettings = useBoard((s) => s.setSettings)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [msg, setMsg] = useState('')
  const [upd, setUpd] = useState<UpdateStatus | null>(null)
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  useEffect(() => {
    void window.ouroboros.app.info().then((i) => {
      setInfo(i)
      setHasToken(Boolean(i.hasUpdateToken))
    })
    return window.ouroboros.update.onStatus(setUpd)
  }, [])
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <label className="row">
          <input type="checkbox" checked={settings.notifications} onChange={(e) => void setSettings({ notifications: e.target.checked })} /> Desktop notifications when an agent needs you
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.minimizeToTray} onChange={(e) => void setSettings({ minimizeToTray: e.target.checked })} /> Keep running in tray when the window is closed
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.trackExternalSessions} onChange={(e) => void toggleExternal(e.target.checked)} /> Track Claude Code sessions started outside Ouroboros (writes a hook into your user settings)
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.claudeLinksExternal ?? true} onChange={(e) => void setSettings({ claudeLinksExternal: e.target.checked })} /> Open claude.ai briefs in your system browser (claude.ai blocks sign-in inside embedded browsers)
        </label>
        <label className="row">
          Browser home
          <input className="text" placeholder="https://www.google.com" defaultValue={settings.browserHome ?? ''} onBlur={(e) => void setSettings({ browserHome: e.target.value.trim() || undefined })} />
        </label>
        <label className="row">
          Default shell
          <input className="text" placeholder={info?.platform === 'win32' ? 'powershell.exe' : '$SHELL'} defaultValue={settings.defaultShell ?? ''} onBlur={(e) => void setSettings({ defaultShell: e.target.value.trim() || undefined })} />
        </label>
        {info && (
          <div className="muted small">
            v{info.version} · hook server on 127.0.0.1:{info.hookPort}
            {info.hookPort !== 47821 ? ' (non-default port: external tracking will not work until restarted with 47821 free)' : ''} · data in {info.userData}
            <br />
            MCP runner: {info.mcpRunner} → {info.mcpScript}
          </div>
        )}
        <div className="block">
          <div className="muted small">Updates · current v{info?.version}</div>
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
                Restart & install v{upd.version}
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
          <label className="row">
            GitHub token
            <input className="text" type="password" placeholder={hasToken ? '•••••• (saved)' : 'fine-grained token, Contents: read on blee170/Ouroboros'} value={token} onChange={(e) => setToken(e.target.value)} />
            <button className="btn" onClick={() => void saveToken()}>
              {token ? 'Save' : hasToken ? 'Clear' : 'Save'}
            </button>
          </label>
          <div className="muted small">Releases are built by GitHub Actions on every version bump. The repository is public, so no token is needed; the field is for private forks (stored encrypted).</div>
        </div>
        {msg && <div className="small">{msg}</div>}
        <div className="row right">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
