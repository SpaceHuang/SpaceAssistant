import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, FileInfo, Message, SearchResult, Session } from '../src/shared/domainTypes'
import type { ClaudeChatCreateWithToolsPayload, ClaudeChatSendStreamPayload, SpaceAssistantApi } from '../src/shared/api'

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
  claudeChatCreateWithTools: (payload: ClaudeChatCreateWithToolsPayload) =>
    ipcRenderer.invoke('claude-chat-create-with-tools', payload),
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
  claudeChatCancel: (payload) => ipcRenderer.invoke('claude-chat-cancel', payload),

  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (payload) => ipcRenderer.invoke('config:set', payload),
  configTestConnection: () => ipcRenderer.invoke('config:test-connection'),

  dialogSelectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  configCheckWorkdirWritable: (dir) => ipcRenderer.invoke('config:check-workdir-writable', dir),

  fileListDirectory: (relPath) => ipcRenderer.invoke('file:list-directory', relPath),
  fileReadFile: (relPath) => ipcRenderer.invoke('file:read-file', relPath),
  fileGetMetadata: (relPath) => ipcRenderer.invoke('file:get-metadata', relPath),
  fileOpenInSystem: (relPath) => ipcRenderer.invoke('file:open-in-system', relPath),
  fileShowInExplorer: (relPath) => ipcRenderer.invoke('file:show-in-explorer', relPath),
  fileExportPdf: (payload) => ipcRenderer.invoke('file:export-pdf', payload),
  fileCreateFile: (relPath) => ipcRenderer.invoke('file:create-file', relPath),
  fileCreateDirectory: (relPath) => ipcRenderer.invoke('file:create-directory', relPath),
  fileDelete: (relPath) => ipcRenderer.invoke('file:delete', relPath),
  fileRename: (relPath, newName) => ipcRenderer.invoke('file:rename', relPath, newName),
  fileMove: (srcRelPath, destDirRelPath) => ipcRenderer.invoke('file:move', srcRelPath, destDirRelPath),

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
  },

  toolConfirmResponse: (payload) => ipcRenderer.invoke('tool:confirm-response', payload),
  toolCancel: (payload) => ipcRenderer.invoke('tool:cancel', payload),
  toolOnUse: (cb) => {
    const fn = (_e: unknown, data: { requestId: string; toolUse: { id: string; name: string; input: unknown } }) => cb(data)
    ipcRenderer.on('tool:use', fn)
    return () => ipcRenderer.removeListener('tool:use', fn)
  },
  toolOnConfirmRequest: (cb) => {
    const fn = (
      _e: unknown,
      data: {
        requestId: string
        toolUseId: string
        toolName: string
        input: unknown
        riskLevel: 'low' | 'medium' | 'high'
        diff?: { oldContent: string; newContent: string; oldPath: string }
      }
    ) => cb(data)
    ipcRenderer.on('tool:confirm-request', fn)
    return () => ipcRenderer.removeListener('tool:confirm-request', fn)
  },
  toolOnProgress: (cb) => {
    const fn = (_e: unknown, data: { requestId: string; toolUseId: string; status: string; message?: string }) => cb(data)
    ipcRenderer.on('tool:progress', fn)
    return () => ipcRenderer.removeListener('tool:progress', fn)
  },
  toolOnResult: (cb) => {
    const fn = (_e: unknown, data: { requestId: string; toolUseId: string; result: { success: boolean; data?: unknown; error?: string } }) =>
      cb(data)
    ipcRenderer.on('tool:result', fn)
    return () => ipcRenderer.removeListener('tool:result', fn)
  },
  toolTestInterpreter: (payload) => ipcRenderer.invoke('tool:test-interpreter', payload),

  skillList: () => ipcRenderer.invoke('skill:list'),
  skillGet: (payload) => ipcRenderer.invoke('skill:get', payload),
  skillInstall: (payload) => ipcRenderer.invoke('skill:install', payload),
  skillDelete: (payload) => ipcRenderer.invoke('skill:delete', payload),
  skillToggleDisable: (payload) => ipcRenderer.invoke('skill:toggle-disable', payload),
  skillOpenDirectory: (payload) => ipcRenderer.invoke('skill:open-directory', payload),
  skillMatch: (payload) => ipcRenderer.invoke('skill:match', payload),
  skillExport: (payload) => ipcRenderer.invoke('skill:export', payload),
  skillInvalidateCache: () => ipcRenderer.invoke('skill:invalidate-cache')
}

contextBridge.exposeInMainWorld('api', api)

export type { AppConfig, FileInfo, Message, SearchResult, Session }
