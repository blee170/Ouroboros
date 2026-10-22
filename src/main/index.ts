import { BrowserWindow, Menu, Tray, app, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Board } from './board'
import { BrowserManager } from './browser-manager'
import { HookServer } from './hook-server'
import { createApiHandlers, registerIpc, resolveMcpScriptPath, type MainContext } from './ipc'
import { PtyManager } from './pty-manager'
import { UserStore } from './workspace-store'
import { Updater, decryptToken } from './updater'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function iconPath(): string {
  const packaged = join(process.resourcesPath ?? '', 'icon.png')
  if (!isDev && existsSync(packaged)) return packaged
  return join(__dirname, '../../resources/icon.png')
}

function createWindow(ctx: MainContext): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1117',
    title: 'Ouroboros',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })
  win.on('close', (e) => {
    if (!quitting && ctx.store.getSettings().minimizeToTray && tray) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function createTray(ctx: MainContext): void {
  const img = nativeImage.createFromPath(iconPath())
  if (img.isEmpty()) return
  tray = new Tray(img.resize({ width: 16, height: 16 }))
  tray.setToolTip('Ouroboros')
  const show = (): void => {
    if (!mainWindow) mainWindow = createWindow(ctx)
    mainWindow.show()
    mainWindow.focus()
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Ouroboros', click: show },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', show)
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  // Separate ids: toasts left in Action Center by a dev run must not COM-activate node_modules\electron.exe later.
  app.setAppUserModelId(isDev ? 'dev.blee170.ouroboros.dev' : 'dev.blee170.ouroboros')
  await app.whenReady()

  const board = new Board()
  const ptys = new PtyManager()
  const store = new UserStore(app.getPath('userData'))
  const ctx: MainContext = {
    board,
    ptys,
    store,
    browsers: new BrowserManager(),
    updater: null as unknown as Updater,
    tmpDir: join(app.getPath('userData'), 'claude-launch'),
    mcpScriptPath: resolveMcpScriptPath(),
    getWindow: () => mainWindow,
    hookServer: null as unknown as HookServer
  }
  ctx.updater = new Updater(() => decryptToken(store.getSettings().githubTokenEnc))
  ctx.hookServer = new HookServer({
    onHook: (nodeId, event) => board.applyHook(nodeId, event),
    onExternalHook: (event) => board.applyExternalHook(event),
    api: createApiHandlers(ctx)
  })
  await ctx.hookServer.start()
  registerIpc(ctx)

  mainWindow = createWindow(ctx)
  createTray(ctx)

  app.on('second-instance', () => {
    if (!mainWindow) mainWindow = createWindow(ctx)
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow(ctx)
  })
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    ptys.killAll()
    ctx.hookServer.stop()
  })
  app.on('window-all-closed', () => {
    if (!ctx.store.getSettings().minimizeToTray || !tray) app.quit()
  })
}

void main()
