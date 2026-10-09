import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type WhenTerminalApi } from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: WhenTerminalApi = {
  getHotkey: () => ipcRenderer.invoke(IPC.getHotkey),
  listProjects: () => ipcRenderer.invoke(IPC.listProjects),
  addProject: () => ipcRenderer.invoke(IPC.addProject),
  removeProject: (projectId) => ipcRenderer.invoke(IPC.removeProject, projectId),
  addConversation: (projectId) => ipcRenderer.invoke(IPC.addConversation, projectId),
  startTask: (projectId, text) => ipcRenderer.invoke(IPC.startTask, projectId, text),
  send: (projectId, conversationId, text) => ipcRenderer.invoke(IPC.send, projectId, conversationId, text),
  interrupt: (projectId, conversationId) => ipcRenderer.invoke(IPC.interrupt, projectId, conversationId),
  setMode: (projectId, conversationId, mode) => ipcRenderer.invoke(IPC.setMode, projectId, conversationId, mode),
  respondPermission: (projectId, conversationId, requestId, decision) =>
    ipcRenderer.invoke(IPC.respondPermission, projectId, conversationId, requestId, decision),
  onEvent: (cb) => subscribe(IPC.event, cb),
  onProjectsChanged: (cb) => subscribe(IPC.projectsChanged, cb),
  onRateLimit: (cb) => subscribe(IPC.rateLimit, cb),
}

contextBridge.exposeInMainWorld('api', api)
