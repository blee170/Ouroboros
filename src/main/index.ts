import { BrowserWindow, Menu, Notification, Tray, app, crashReporter, globalShortcut, nativeImage, session, shell } from 'electron'
import { whisper } from './stt'
import { initDiagnostics, log } from './diagnostics'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Board } from './board'
import { BrowserManager } from './browser-manager'
import { HookServer, PREFERRED_HOOK_PORT } from './hook-server'
import type { PhoneServer } from './phone-server'
import { globalExternalHooksInstalled, loadExternalToken, setGlobalExternalHooks } from './external'

/** The external-hook token; an unwritable data folder must not stop the app (outside sessions just go unseen). */
function externalTokenOrNull(): string | undefined {
  try {
    return loadExternalToken(app.getPath('userData'))
  } catch (err) {
    log(`external hook token unavailable: ${(err as Error).message}`)
    return undefined
  }
}
import { registerVoiceHotkey, publishReleaseNotes, createSession, initialProjectArg, projectFromArgv, registerIpc, resolveMcpScriptPath, createPhone, routeExternalHook, routeGate, routeHook, type MainContext, type WindowSession } from './ipc'
import { RoleLibrary } from './roles'
import { BoardTrust } from './board-trust'
import { onBoardWritten } from './workspace-store'
import { PtyManager } from './pty-manager'
import { UserStore } from './workspace-store'
import { Updater, decryptToken } from './updater'
import { SessionRegistry } from './windows'
import { UsageMonitor } from './usage'
import { detectEngines } from './engines'
import { homedir } from 'node:os'

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
  // links in rendered replies and notes are agent-written: only the web may open, and only outside this window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
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
  // Electron's default menu keeps Ctrl+R (reloads the board and relaunches every card) and Ctrl+W live even
  // with the bar hidden; the packaged app has no menu at all (dev keeps it for DevTools)
  if (!isDev) Menu.setApplicationMenu(null)
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
    roles: new RoleLibrary(join(app.getPath('userData'), 'roles', 'agency-agents')),
    hookServer: null as unknown as HookServer,
    phone: null as unknown as PhoneServer,
    boardTrust: new BoardTrust(join(app.getPath('userData'), 'board-trust.json'), log),
    usage: new UsageMonitor({ home: homedir(), env: process.env, now: Date.now, fetch: (url, init) => fetch(url, init), detect: detectEngines })
  }
  onBoardWritten((root, text, fromDisk) => ctx.boardTrust.record(root, text, { fromDisk }))
  ctx.updater = new Updater(() => decryptToken(store.getSettings().githubTokenEnc))
  ctx.hookServer = new HookServer({
    onHook: (nodeId, event) => routeHook(ctx, nodeId, event),
    onExternalHook: (event) => routeExternalHook(ctx, event),
    onStatusLine: (nodeId, body) => ctx.usage.onStatusLine(nodeId, body),
    onGate: (nodeId, input) => routeGate(ctx, nodeId, input),
    // A caller identifies its window by its own card id; unscoped calls go to the current window.
    // a named card must still be on a board: a closed card's token keeps working until relaunch, but reaches no window
    resolveApi: (selfId) => (selfId ? ctx.windows.forNode(selfId)?.api : ctx.windows.current()?.api),
    externalToken: externalTokenOrNull(),
    log
  })
  await ctx.hookServer.start()
  // the installed global hook carries this launch's port and the external token: write it again (an older one has no token)
  // only the instance on the fixed port owns that hook: a second Ouroboros (another data folder, a dev build) leaves it alone
  if (ctx.hookServer.port === PREFERRED_HOOK_PORT && ctx.hookServer.externalToken && globalExternalHooksInstalled()) {
    try {
      setGlobalExternalHooks(true, ctx.hookServer.baseUrl, ctx.hookServer.externalToken)
    } catch (err) {
      log(`external hooks not updated: ${(err as Error).message}`)
    }
  }
  ctx.phone = createPhone(ctx)
  registerIpc(ctx)
  // the microphone is for the app's own window (the voice composer), audio only: a page in a browser card (its own
  // persist:ouroboros-browser session) gets neither mic nor camera. Everything else keeps Electron's default (allowed).
  const guardMedia = (ses: Electron.Session): void => {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission !== 'media') return callback(true)
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      callback(wc.getType() === 'window' && types.length > 0 && types.every((m) => m === 'audio'))
    })
    ses.setPermissionCheckHandler((wc, permission) => (permission === 'media' ? wc?.getType() === 'window' : true))
  }
  app.on('session-created', guardMedia)
  guardMedia(session.defaultSession)
  guardMedia(session.fromPartition('persist:ouroboros-browser'))
  registerVoiceHotkey(ctx)
  const phoneView = store.getSettings().phone
  if (phoneView?.enabled) {
    void ctx.phone.apply(phoneView).then((err) => {
      if (err) log(`[phone] not started: ${err}`)
      // the owner sees that the phone server came up, and with how many phones: a settings file changed behind their back shows here
      if (Notification.isSupported()) new Notification({ title: 'Phone companion is on', body: err ? `Not listening: ${err}` : `${ctx.phone.url} · ${ctx.phone.devices.list.length} phone(s) paired. Turn it off in Settings → Phone.` }).show()
    })
  }

  createWindow(ctx, initialProjectArg())
  createTray(ctx)
  // a dev build has no section of its own in the CHANGELOG and must not publish the installed version's notes
  if (app.isPackaged) void publishReleaseNotes(ctx, app.getVersion()).catch((err) => log(`[notion] release notes: ${(err as Error).message}`))

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
    ctx.phone?.stop()
    whisper.stop()
    globalShortcut.unregisterAll()
  })
  app.on('window-all-closed', () => {
    if (!ctx.store.getSettings().minimizeToTray || !tray) app.quit()
  })
}

void main()
