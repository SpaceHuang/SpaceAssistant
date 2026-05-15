import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, FileInfo, Message, SearchResult, Session } from '../src/shared/domainTypes'
import type { ClaudeChatSendStreamPayload, SpaceAssistantApi } from '../src/shared/api'

const api: SpaceAssistantApi = {
  ping: () => ipcRenderer.invoke('ping'),

  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionCreate: (payload) => ipcRenderer.invoke('session:create', payload),
  sessionGet: (sessionId) => ipcRenderer.invoke('session:get', sessionId),
  sessionUpdate: (payload) => ipcRenderer.invoke('session:update', payload),
  sessionDelete: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),

  chatGetMessages: (payload) => ipcRenderer.invoke('chat:get-messages', payload),
  chatAppendMessage: (msg) => ipcRenderer.invoke('chat:append-message', msg),
  chatPatchMessage: (payload) => ipcRenderer.invoke('chat:patch-message', payload),

  claudeChatSendStream: (payload: ClaudeChatSendStreamPayload) => ipcRenderer.invoke('claude-chat-send-stream', payload),
  claudeChatOnDelta: (cb) => {
    const fn = (_e: unknown, data: { requestId: string; text: string }) => cb(data)
    ipcRenderer.on('claude-chat-delta', fn)
    return () => ipcRenderer.removeListener('claude-chat-delta', fn)
  },
  claudeChatOnThinkingDelta: (cb) => {
    const fn = (_e: unknown, data: { requestId: string; text: string }) => cb(data)
    ipcRenderer.on('claude-chat-thinking-delta', fn)
    return () => ipcRenderer.removeListener('claude-chat-thinking-delta', fn)
  },
  claudeChatOnDone: (cb) => {
    const fn = (_e: unknown, data: { requestId: string }) => cb(data)
    ipcRenderer.on('claude-chat-done', fn)
    return () => ipcRenderer.removeListener('claude-chat-done', fn)
  },
  claudeChatOnError: (cb) => {
    const fn = (_e: unknown, data: { requestId: string; message: string }) => cb(data)
    ipcRenderer.on('claude-chat-error', fn)
    return () => ipcRenderer.removeListener('claude-chat-error', fn)
  },

  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (payload) => ipcRenderer.invoke('config:set', payload),
  configTestConnection: () => ipcRenderer.invoke('config:test-connection'),

  dialogSelectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  configCheckWorkdirWritable: (dir) => ipcRenderer.invoke('config:check-workdir-writable', dir),

  fileListDirectory: (relPath) => ipcRenderer.invoke('file:list-directory', relPath),
  fileReadFile: (relPath) => ipcRenderer.invoke('file:read-file', relPath),

  searchExecute: (query) => ipcRenderer.invoke('search:execute', query),
  searchGetHistory: () => ipcRenderer.invoke('search:get-history'),

  onOpenSettings: (cb) => {
    const fn = () => cb()
    ipcRenderer.on('app:open-settings', fn)
    return () => ipcRenderer.removeListener('app:open-settings', fn)
  },
  onOpenAbout: (cb) => {
    const fn = () => cb()
    ipcRenderer.on('app:open-about', fn)
    return () => ipcRenderer.removeListener('app:open-about', fn)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type { AppConfig, FileInfo, Message, SearchResult, Session }
