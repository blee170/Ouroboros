import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'
import type { AppInfo } from '@shared/protocol'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useBoard((s) => s.settings)
  const setSettings = useBoard((s) => s.setSettings)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    void window.ouroboros.app.info().then(setInfo)
  }, [])

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
