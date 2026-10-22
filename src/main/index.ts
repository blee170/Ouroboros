import { BrowserWindow, Menu, Tray, app, crashReporter, nativeImage, shell } from 'electron'
import { initDiagnostics, log } from './diagnostics'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Board } from './board'
import { BrowserManager } from './browser-manager'
import { HookServer } from './hook-server'
import { createSession, initialProjectArg, projectFromArgv, registerIpc, resolveMcpScriptPath, routeExternalHook, routeHook, type MainContext, type WindowSession } from './ipc'
import { PtyManager } from './pty-manager'
import { UserStore } from './workspace-store'
import { Updater, decryptToken } from './updater'
import { SessionRegistry } from './windows'

const isDev = !app.isPackaged
let tray: Tray | null = null
let quitting = false

function iconPath(): string {
  const packaged = join(process.resourcesPath ?? '', 'icon.png')
  if (!isDev && existsSync(packaged)) return packaged
  return join(__dirname, '../../resources/icon.png')
}

/** One window = one project. Each window gets its own Board and API scope. */
function createWindow(ctx: MainContext, projectRoot?: string): WindowSession {
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
  const session = createSession(ctx, win, new Board(), projectRoot)
  ctx.windows.add(session)
  win.on('focus', () => ctx.windows.touch(session.id))
  win.on('close', (e) => {
    // Only the last window hides to the tray; other windows close for real (their cards end).
    if (!quitting && ctx.store.getSettings().minimizeToTray && tray && ctx.windows.size === 1) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    ctx.windows.remove(session.id)
    session.dispose()
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
  return session
}

function showAll(ctx: MainContext): void {
  if (ctx.windows.size === 0) {
    createWindow(ctx)
    return
  }
  for (const s of ctx.windows.all()) if (!s.win.isDestroyed()) s.win.show()
  const cur = ctx.windows.current()
  if (cur && !cur.win.isDestroyed()) cur.win.focus()
}

function createTray(ctx: MainContext): void {
  const img = nativeImage.createFromPath(iconPath())
  if (img.isEmpty()) return
  tray = new Tray(img.resize({ width: 16, height: 16 }))
  tray.setToolTip('Ouroboros')
  const show = (): void => showAll(ctx)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Ouroboros', click: show },
      { label: 'New window', click: () => void createWindow(ctx) },
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
  // Local-only crash dumps (userData/Crashpad/reports) and a main.log trail: no upload anywhere.
  try {
    crashReporter.start({ submitURL: '', uploadToServer: false, compress: false, ignoreSystemCrashHandler: false })
  } catch {
    /* unsupported platform or already started */
  }
  initDiagnostics(app.getPath('userData'))
  log(`start v${app.getVersion()} electron=${process.versions.electron} ${process.platform} ${process.arch}`)
  process.on('uncaughtException', (err) => log(`uncaughtException: ${err?.stack ?? String(err)}`))
  process.on('unhandledRejection', (err) => log(`unhandledRejection: ${(err as Error)?.stack ?? String(err)}`))
  app.on('child-process-gone', (_e, d) => log(`child-process-gone type=${d.type} reason=${d.reason} exit=${d.exitCode} name=${d.name ?? ''}`))
  app.on('render-process-gone', (_e, wc, d) => log(`render-process-gone wc=${wc.id} reason=${d.reason} exit=${d.exitCode}`))
  // Browser cards present a plain Chrome UA (consistently, client hints included): Google sign-in and
  // bot checks refuse anything that mentions Electron.
  app.userAgentFallback = app.userAgentFallback.replace(/\s?Electron\/[\d.]+/, '').replace(/\s?ouroboros\/[\d.]+/i, '')
  await app.whenReady()

  const ptys = new PtyManager()
  const store = new UserStore(app.getPath('userData'))
  const ctx: MainContext = {
    windows: new SessionRegistry<WindowSession>(),
    openProjectWindow: (projectRoot) => {
      const existing = projectRoot ? ctx.windows.forProject(projectRoot) : undefined
      if (existing) {
        existing.win.show()
        existing.win.focus()
        return existing
      }
      return createWindow(ctx, projectRoot)
    },
    ptys,
    store,
    browsers: new BrowserManager(),
    updater: null as unknown as Updater,
    tmpDir: join(app.getPath('userData'), 'claude-launch'),
    mcpScriptPath: resolveMcpScriptPath(),
    hookServer: null as unknown as HookServer
  }
  ctx.updater = new Updater(() => decryptToken(store.getSettings().githubTokenEnc))
  ctx.hookServer = new HookServer({
    onHook: (nodeId, event) => routeHook(ctx, nodeId, event),
    onExternalHook: (event) => routeExternalHook(ctx, event),
    // A caller identifies its window by its own card id; unscoped calls go to the current window.
    resolveApi: (selfId) => (selfId ? ctx.windows.forNode(selfId) : undefined)?.api ?? ctx.windows.current()?.api
  })
  await ctx.hookServer.start()
  registerIpc(ctx)

  createWindow(ctx, initialProjectArg())
  createTray(ctx)

  app.on('second-instance', (_e, argv, cwd) => {
    // `Ouroboros.exe <folder>` while running: open that folder in its own window.
    const root = projectFromArgv(argv, cwd, app.isPackaged)
    if (root) ctx.openProjectWindow(root)
    else showAll(ctx)
  })
  app.on('activate', () => {
    if (ctx.windows.size === 0) createWindow(ctx)
  })
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    log('will-quit')
    ptys.killAll()
    ctx.hookServer.stop()
  })
  app.on('window-all-closed', () => {
    if (!ctx.store.getSettings().minimizeToTray || !tray) app.quit()
  })
}

void main()
