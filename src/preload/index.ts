import { contextBridge, ipcRenderer } from 'electron'
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
    onData: (cb) => on<{ nodeId: string; data: string }>(IPC.ptyData, (p) => cb(p.nodeId, p.data)),
    onExit: (cb) => on<{ nodeId: string; code: number }>(IPC.ptyExit, (p) => cb(p.nodeId, p.code))
  },
  claude: {
    launch: (opts) => ipcRenderer.invoke(IPC.claudeLaunch, opts)
  },
  board: {
    sync: (payload) => ipcRenderer.send(IPC.boardSync, payload),
    onAgentStatus: (cb) => on(IPC.agentStatus, cb),
    onHookEvent: (cb) => on(IPC.hookEvent, cb),
    onHandoffFired: (cb) => on(IPC.handoffFired, cb),
    onAddNode: (cb) => on(IPC.boardAddNode, cb),
    onSetNote: (cb) => on(IPC.boardSetNote, cb),
    onExternalSession: (cb) => on(IPC.externalSession, cb),
    fireHandoff: (edgeId) => ipcRenderer.invoke(IPC.handoffFire, edgeId),
    listAgents: () => ipcRenderer.invoke(IPC.agentsList)
  },
  workspace: {
    load: (projectRoot) => ipcRenderer.invoke(IPC.workspaceLoad, projectRoot),
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
  }
}

contextBridge.exposeInMainWorld('ouroboros', api)
