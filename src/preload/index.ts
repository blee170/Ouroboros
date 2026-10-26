import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type OuroborosApi } from '@shared/protocol'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: OuroborosApi = {
  pty: {
    spawn: (opts) => ipcRenderer.invoke(IPC.ptySpawn, opts),
    write: (nodeId, data) => ipcRenderer.send(IPC.ptyWrite, nodeId, data),
    resize: (nodeId, cols, rows) => ipcRenderer.send(IPC.ptyResize, nodeId, cols, rows),
    kill: (nodeId) => ipcRenderer.invoke(IPC.ptyKill, nodeId),
    pasteImage: (nodeId, path) => ipcRenderer.invoke(IPC.ptyPasteImage, nodeId, path),
    onData: (cb) => on<{ nodeId: string; data: string }>(IPC.ptyData, (p) => cb(p.nodeId, p.data)),
    onExit: (cb) => on<{ nodeId: string; code: number }>(IPC.ptyExit, (p) => cb(p.nodeId, p.code))
  },
  claude: {
    launch: (opts) => ipcRenderer.invoke(IPC.claudeLaunch, opts)
  },
  board: {
    sync: (payload) => ipcRenderer.send(IPC.boardSync, payload),
    setSelected: (nodeId) => ipcRenderer.send(IPC.boardSelected, nodeId),
    onAgentStatus: (cb) => on(IPC.agentStatus, cb),
    onHookEvent: (cb) => on(IPC.hookEvent, cb),
    onHandoffFired: (cb) => on(IPC.handoffFired, cb),
    onAddNode: (cb) => on(IPC.boardAddNode, cb),
    onAddEdge: (cb) => on(IPC.boardAddEdge, cb),
    onRemoveNode: (cb) => on(IPC.boardRemoveNode, cb),
    onRemoveEdge: (cb) => on(IPC.boardRemoveEdge, cb),
    onSetNote: (cb) => on(IPC.boardSetNote, cb),
    onUpdateNode: (cb) => on(IPC.boardUpdateNode, cb),
    onExternalSession: (cb) => on(IPC.externalSession, cb),
    onAnnounce: (cb) => on(IPC.announce, cb),
    fireHandoff: (edgeId) => ipcRenderer.invoke(IPC.handoffFire, edgeId),
    listAgents: () => ipcRenderer.invoke(IPC.agentsList)
  },
  workspace: {
    load: (projectRoot) => ipcRenderer.invoke(IPC.workspaceLoad, projectRoot),
    trust: (nodeIds, revert) => ipcRenderer.invoke(IPC.workspaceTrust, nodeIds, revert),
    save: (ws) => ipcRenderer.invoke(IPC.workspaceSave, ws),
    openProject: () => ipcRenderer.invoke(IPC.projectOpen),
    recent: () => ipcRenderer.invoke(IPC.projectRecent)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  worktree: {
    create: (projectRoot, name) => ipcRenderer.invoke(IPC.worktreeCreate, projectRoot, name),
    remove: (projectRoot, path) => ipcRenderer.invoke(IPC.worktreeRemove, projectRoot, path)
  },
  external: {
    installHooks: (enable) => ipcRenderer.invoke(IPC.externalInstallHooks, enable)
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo)
  },
  window: {
    open: (projectRoot) => ipcRenderer.invoke(IPC.windowOpen, projectRoot)
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.shellOpenExternal, url),
    openPath: (path, cwd) => ipcRenderer.invoke(IPC.shellOpenPath, path, cwd)
  },
  brief: {
    open: (url, near) => ipcRenderer.invoke(IPC.briefOpen, url, near)
  },
  autonomy: {
    start: (config) => ipcRenderer.invoke(IPC.autonomyStart, config),
    stop: () => ipcRenderer.invoke(IPC.autonomyStop),
    state: () => ipcRenderer.invoke(IPC.autonomyState),
    onChange: (cb) => on(IPC.autonomyChanged, cb)
  },
  changes: {
    summary: (cwd) => ipcRenderer.invoke(IPC.changesSummary, cwd),
    diff: (cwd, file) => ipcRenderer.invoke(IPC.changesDiff, cwd, file),
    revert: (cwd, file) => ipcRenderer.invoke(IPC.changesRevert, cwd, file)
  },
  checkpoints: {
    list: (cwd) => ipcRenderer.invoke(IPC.checkpointsList, cwd),
    create: (cwd, label) => ipcRenderer.invoke(IPC.checkpointsCreate, cwd, label),
    restore: (cwd, id, moveHead) => ipcRenderer.invoke(IPC.checkpointsRestore, cwd, id, moveHead),
    delete: (cwd, id) => ipcRenderer.invoke(IPC.checkpointsDelete, cwd, id)
  },
  session: {
    usage: (sessionId) => ipcRenderer.invoke(IPC.sessionUsage, sessionId)
  },
  usage: {
    get: () => ipcRenderer.invoke(IPC.usageGet),
    refresh: () => ipcRenderer.invoke(IPC.usageRefresh),
    onChange: (cb) => on(IPC.usageChanged, cb)
  },
  engines: {
    detect: () => ipcRenderer.invoke(IPC.enginesDetect)
  },
  files: {
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
    saveImage: (bytes, ext) => ipcRenderer.invoke(IPC.filesSaveImage, bytes, ext),
    pasteClipboard: (saveImage) => ipcRenderer.invoke(IPC.filesPasteClipboard, saveImage !== false)
  },
  skills: {
    list: (cwd) => ipcRenderer.invoke(IPC.skillsList, cwd)
  },
  roles: {
    list: (cwd) => ipcRenderer.invoke(IPC.rolesList, cwd),
    fetch: () => ipcRenderer.invoke(IPC.rolesFetch),
    read: (cwd, id) => ipcRenderer.invoke(IPC.rolesRead, cwd, id)
  },
  tasks: {
    list: () => ipcRenderer.invoke(IPC.tasksList),
    create: (input) => ipcRenderer.invoke(IPC.tasksCreate, input),
    update: (id, patch) => ipcRenderer.invoke(IPC.tasksUpdate, id, patch),
    onChange: (cb) => on(IPC.tasksChanged, cb)
  },
  mail: {
    list: () => ipcRenderer.invoke(IPC.mailList),
    send: (to, body) => ipcRenderer.invoke(IPC.mailSend, to, body),
    onChange: (cb) => on(IPC.mailChanged, cb)
  },
  voice: {
    transcribe: (wav, override) => ipcRenderer.invoke(IPC.voiceTranscribe, wav, override),
    setListening: (on) => ipcRenderer.invoke(IPC.voiceListening, on),
    onHotkey: (cb) => on(IPC.voiceHotkey, cb)
  },
  phone: {
    status: () => ipcRenderer.invoke(IPC.phoneStatus),
    interfaces: () => ipcRenderer.invoke(IPC.phoneInterfaces),
    configure: (view) => ipcRenderer.invoke(IPC.phoneConfigure, view),
    pair: () => ipcRenderer.invoke(IPC.phonePair),
    revoke: (id) => ipcRenderer.invoke(IPC.phoneRevoke, id)
  },
  gate: {
    list: () => ipcRenderer.invoke(IPC.gateList),
    resolve: (id, approve) => ipcRenderer.invoke(IPC.gateResolve, id, approve),
    onChange: (cb) => on(IPC.gateChanged, cb)
  },
  grokBot: {
    list: () => ipcRenderer.invoke(IPC.grokBotList),
    resolve: (id, send) => ipcRenderer.invoke(IPC.grokBotResolve, id, send),
    onChange: (cb) => on(IPC.grokBotChanged, cb),
    setKey: (key) => ipcRenderer.invoke(IPC.grokBotSetKey, key),
    status: () => ipcRenderer.invoke(IPC.grokBotStatus),
    test: () => ipcRenderer.invoke(IPC.grokBotTest)
  },
  github: {
    protection: () => ipcRenderer.invoke(IPC.githubProtection),
    protect: () => ipcRenderer.invoke(IPC.githubProtect),
    setCardToken: (token) => ipcRenderer.invoke(IPC.githubSetCardToken, token),
    cardTokenStatus: (check) => ipcRenderer.invoke(IPC.githubCardTokenStatus, check === true)
  },
  history: {
    list: (rootFilter) => ipcRenderer.invoke(IPC.historyList, rootFilter)
  },
  folders: {
    list: (root) => ipcRenderer.invoke(IPC.foldersList, root)
  },
  browser: {
    register: (nodeId, webContentsId) => ipcRenderer.send(IPC.browserRegister, nodeId, webContentsId),
    unregister: (nodeId) => ipcRenderer.send(IPC.browserUnregister, nodeId)
  },
  bookmarks: {
    list: (query) => ipcRenderer.invoke(IPC.bookmarksList, query)
  },
  tidy: {
    candidates: (olderThanMinutes, includeOwn) => ipcRenderer.invoke(IPC.tidyCandidates, olderThanMinutes, includeOwn === true),
    apply: (ids) => ipcRenderer.invoke(IPC.tidyApply, ids)
  },
  update: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    setToken: (token) => ipcRenderer.invoke(IPC.updateSetToken, token),
    onStatus: (cb) => on(IPC.updateStatus, cb)
  },
  tts: {
    synthesize: (text) => ipcRenderer.invoke(IPC.ttsSynthesize, text),
    setKey: (engine, key) => ipcRenderer.invoke(IPC.ttsSetKey, engine, key),
    keys: () => ipcRenderer.invoke(IPC.ttsKeys)
  },
  notion: {
    setToken: (token) => ipcRenderer.invoke(IPC.notionSetToken, token),
    status: () => ipcRenderer.invoke(IPC.notionStatus),
    test: (which) => ipcRenderer.invoke(IPC.notionTest, which),
    addViews: () => ipcRenderer.invoke(IPC.notionViews)
  },
  obsidian: {
    pick: () => ipcRenderer.invoke(IPC.obsidianPick),
    exportNow: () => ipcRenderer.invoke(IPC.obsidianExport)
  }
}

contextBridge.exposeInMainWorld('ouroboros', api)
