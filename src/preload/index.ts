import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
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
  closeConversation: (projectId, conversationId) => ipcRenderer.invoke(IPC.closeConversation, projectId, conversationId),
  reopenConversation: (projectId, conversationId) => ipcRenderer.invoke(IPC.reopenConversation, projectId, conversationId),
  saveTask: (projectId, conversationId, task) => ipcRenderer.invoke(IPC.saveTask, projectId, conversationId, task),
  startTask: (projectId, text, continueId) => ipcRenderer.invoke(IPC.startTask, projectId, text, continueId),
  send: (projectId, conversationId, text) => ipcRenderer.invoke(IPC.send, projectId, conversationId, text),
  interrupt: (projectId, conversationId) => ipcRenderer.invoke(IPC.interrupt, projectId, conversationId),
  renameConversation: (projectId, conversationId, title) => ipcRenderer.invoke(IPC.renameConversation, projectId, conversationId, title),
  stopTask: (projectId, conversationId, taskId) => ipcRenderer.invoke(IPC.stopTask, projectId, conversationId, taskId),
  taskOutput: (projectId, conversationId, taskId) => ipcRenderer.invoke(IPC.taskOutput, projectId, conversationId, taskId),
  setMode: (projectId, conversationId, mode) => ipcRenderer.invoke(IPC.setMode, projectId, conversationId, mode),
  respondPermission: (projectId, conversationId, requestId, decision) =>
    ipcRenderer.invoke(IPC.respondPermission, projectId, conversationId, requestId, decision),
  compact: (projectId, conversationId, instructions) => ipcRenderer.invoke(IPC.compact, projectId, conversationId, instructions),
  clear: (projectId, conversationId) => ipcRenderer.invoke(IPC.clear, projectId, conversationId),
  listCommands: (projectId) => ipcRenderer.invoke(IPC.listCommands, projectId),
  peek: (projectId, conversationId) => ipcRenderer.invoke(IPC.peek, projectId, conversationId),
  searchFiles: (projectId, conversationId, query) => ipcRenderer.invoke(IPC.searchFiles, projectId, conversationId, query),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveImage: (data, ext) => ipcRenderer.invoke(IPC.saveImage, data, ext),
  worktreeChanges: (projectId, conversationId) => ipcRenderer.invoke(IPC.worktreeChanges, projectId, conversationId),
  worktreeMerge: (projectId, conversationId) => ipcRenderer.invoke(IPC.worktreeMerge, projectId, conversationId),
  worktreeDiscard: (projectId, conversationId) => ipcRenderer.invoke(IPC.worktreeDiscard, projectId, conversationId),
  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles),
  listModels: (projectId) => ipcRenderer.invoke(IPC.listModels, projectId),
  setModel: (projectId, conversationId, option) => ipcRenderer.invoke(IPC.setModel, projectId, conversationId, option),
  loadHistory: (projectId, conversationId) => ipcRenderer.invoke(IPC.loadHistory, projectId, conversationId),
  initialSettings: ipcRenderer.sendSync(IPC.getSettingsSync),
  appInfo: ipcRenderer.sendSync(IPC.appInfo),
  setSettings: (settings) => ipcRenderer.invoke(IPC.setSettings, settings),
  onSettingsChanged: (cb) => subscribe(IPC.settingsChanged, cb),
  onOpenSettings: (cb) => subscribe(IPC.openSettings, () => cb()),
  onNavigate: (cb) => subscribe(IPC.navigate, cb),
  setBadge: (waiting, unread) => ipcRenderer.send(IPC.setBadge, waiting, unread),
  onEvent: (cb) => subscribe(IPC.event, cb),
  onProjectsChanged: (cb) => subscribe(IPC.projectsChanged, cb),
  onRateLimit: (cb) => subscribe(IPC.rateLimit, cb),
  getUsage: (refresh) => ipcRenderer.invoke(IPC.getUsage, refresh),
  onUsage: (cb) => subscribe(IPC.usage, cb),
  searchConversations: (query) => ipcRenderer.invoke(IPC.searchConversations, query),
  terminalOpen: (projectId, conversationId, cols, rows) => ipcRenderer.invoke(IPC.terminalOpen, projectId, conversationId, cols, rows),
  terminalWrite: (conversationId, data) => ipcRenderer.send(IPC.terminalWrite, conversationId, data),
  terminalResize: (conversationId, cols, rows) => ipcRenderer.send(IPC.terminalResize, conversationId, cols, rows),
  terminalClose: (conversationId) => ipcRenderer.invoke(IPC.terminalClose, conversationId),
  onTerminalData: (cb) => subscribe(IPC.terminalData, cb),
  onTerminalExit: (cb) => subscribe(IPC.terminalExit, cb),
  getUpdate: () => ipcRenderer.invoke(IPC.getUpdate),
  checkUpdate: () => ipcRenderer.invoke(IPC.checkUpdate),
  applyUpdate: () => ipcRenderer.send(IPC.applyUpdate),
  onUpdate: (cb) => subscribe(IPC.updateChanged, cb),
}

contextBridge.exposeInMainWorld('api', api)
