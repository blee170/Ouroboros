import { app, safeStorage } from 'electron'
import { EventEmitter } from 'node:events'
import type { UpdateStatus } from '@shared/protocol'

/**
 * In-app updates from GitHub Releases (built by .github/workflows/release.yml).
 * The repository is private, so downloads need a GitHub token with read access to its contents;
 * the token is stored encrypted (safeStorage) in the user settings.
 */
export class Updater extends EventEmitter {
  status: UpdateStatus = { state: app.isPackaged ? 'idle' : 'unavailable', currentVersion: app.getVersion(), message: app.isPackaged ? undefined : 'dev build: pull & rebuild instead' }
  private wired = false

  constructor(private getToken: () => string | undefined) {
    super()
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch, currentVersion: app.getVersion() }
    this.emit('status', this.status)
  }

  private async updater(): Promise<typeof import('electron-updater').autoUpdater> {
    const { autoUpdater } = await import('electron-updater')
    if (!this.wired) {
      this.wired = true
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.logger = null
      autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', message: undefined }))
      autoUpdater.on('update-available', (info) => this.set({ state: 'available', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined }))
      autoUpdater.on('update-not-available', () => this.set({ state: 'up-to-date' }))
      autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }))
      autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version, percent: 100 }))
      autoUpdater.on('error', (err) => this.set({ state: 'error', message: friendly(err) }))
    }
    const token = this.getToken()
    autoUpdater.setFeedURL({ provider: 'github', owner: 'blee170', repo: 'Ouroboros', private: Boolean(token), token: token || undefined })
    return autoUpdater
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.status
    try {
      const u = await this.updater()
      await u.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', message: friendly(err) })
    }
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.status
    try {
      const u = await this.updater()
      this.set({ state: 'downloading', percent: 0 })
      await u.downloadUpdate()
    } catch (err) {
      this.set({ state: 'error', message: friendly(err) })
    }
    return this.status
  }

  async install(): Promise<void> {
    if (!app.isPackaged) return
    const u = await this.updater()
    setImmediate(() => u.quitAndInstall(false, true))
  }
}

function friendly(err: unknown): string {
  const m = String((err as Error)?.message ?? err)
  if (/404|Not Found/i.test(m)) return 'No release found (or the token cannot read the private repository). Check the GitHub token in Settings.'
  if (/401|403|Bad credentials/i.test(m)) return 'GitHub token rejected. Create a fine-grained token with Contents: read on blee170/Ouroboros.'
  if (/ENOTFOUND|ECONN|network/i.test(m)) return 'Network error while contacting GitHub.'
  return m.length > 300 ? m.slice(0, 300) + '…' : m
}

export function encryptToken(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) return 'plain:' + plain
  return 'enc:' + safeStorage.encryptString(plain).toString('base64')
}

export function decryptToken(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  if (stored.startsWith('plain:')) return stored.slice(6)
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch {
      return undefined
    }
  }
  return stored
}
