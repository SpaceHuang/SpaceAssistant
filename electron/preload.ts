import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, FileInfo, Message, SearchResult, Session } from '../src/shared/domainTypes'
import type { ClaudeChatCreateWithToolsPayload, ClaudeChatSendStreamPayload, SpaceAssistantApi } from '../src/shared/api'

const api: SpaceAssistantApi = {
  ping: () => ipcRenderer.invoke('ping'),

  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionCreate: (payload) => ipcRenderer.invoke('session:create', payload),
  sessionGet: (sessionId) => ipcRenderer.invoke('session:get', sessionId),
  sessionUpdate: (payload) => ipcRenderer.invoke('session:update', payload),
  sessionBackfillAutoTitleIfNeeded: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('session:backfill-auto-title-if-needed', payload) as Promise<Session | undefined>,
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
  configTestConnection: (options?: { serviceId?: string; apiKey?: string; baseUrl?: string }) =>
    ipcRenderer.invoke('config:test-connection', options),

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
  fileCopy: (payload) => ipcRenderer.invoke('file:copy', payload),

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

  sessionOnTitleGenerated: (cb) => {
    const fn = (_e: unknown, data: { session: Session }) => cb(data)
    ipcRenderer.on('session:title-generated', fn)
    return () => ipcRenderer.removeListener('session:title-generated', fn)
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
        shellSecurityHints?: import('../src/shared/domainTypes').ShellSecurityHints
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
  shellTestExecutable: (payload: { executable?: string; argsPrefix?: string[] }) =>
    ipcRenderer.invoke('shell:test-executable', payload),
  shellOpenOutputPath: (absPath: string) => ipcRenderer.invoke('shell:open-output-path', absPath),
  shellOpenTerminal: (payload: { cwd: string }) => ipcRenderer.invoke('shell:open-terminal', payload),

  browserDetect: (force?: boolean) => ipcRenderer.invoke('browser:detect', force),
  browserOpenTerminal: () => ipcRenderer.invoke('browser:open-terminal'),

  skillList: () => ipcRenderer.invoke('skill:list'),
  skillGet: (payload) => ipcRenderer.invoke('skill:get', payload),
  skillInstall: (payload) => ipcRenderer.invoke('skill:install', payload),
  skillInstallFromUrl: (payload) => ipcRenderer.invoke('skill:install-from-url', payload),
  skillDelete: (payload) => ipcRenderer.invoke('skill:delete', payload),
  skillToggleDisable: (payload) => ipcRenderer.invoke('skill:toggle-disable', payload),
  skillOpenDirectory: (payload) => ipcRenderer.invoke('skill:open-directory', payload),
  skillMatch: (payload) => ipcRenderer.invoke('skill:match', payload),
  skillRoute: (payload) => ipcRenderer.invoke('skill:route', payload),
  skillExport: (payload) => ipcRenderer.invoke('skill:export', payload),
  skillInvalidateCache: () => ipcRenderer.invoke('skill:invalidate-cache'),

  wikiInit: (payload?: { overwrite?: boolean; installSkill?: boolean }) => ipcRenderer.invoke('wiki:init', payload ?? {}),
  wikiStatus: () => ipcRenderer.invoke('wiki:status'),
  wikiGetSchema: () => ipcRenderer.invoke('wiki:get-schema'),
  wikiResolvePath: (payload: { relPath: string }) => ipcRenderer.invoke('wiki:resolve-path', payload),
  wikiImportRaw: (payload: { srcRelPath: string }) => ipcRenderer.invoke('wiki:import-raw', payload),

  projectMemoryGetState: () => ipcRenderer.invoke('project-memory:get-state'),
  projectMemoryGenerate: () => ipcRenderer.invoke('project-memory:generate'),
  projectMemoryWrite: (payload) => ipcRenderer.invoke('project-memory:write', payload),
  projectMemoryReload: () => ipcRenderer.invoke('project-memory:reload'),
  projectMemoryOnStateChanged: (cb) => {
    const fn = (_e: unknown, data: import('../src/shared/domainTypes').ProjectMemoryState) => cb(data)
    ipcRenderer.on('project-memory:state-changed', fn)
    return () => ipcRenderer.removeListener('project-memory:state-changed', fn)
  },

  feishuDetectCli: () => ipcRenderer.invoke('feishu:detect-cli'),
  feishuInstallCli: () => ipcRenderer.invoke('feishu:install-cli'),
  feishuInstallSkill: () => ipcRenderer.invoke('feishu:install-skill'),
  feishuConfigInit: () => ipcRenderer.invoke('feishu:config-init'),
  feishuAuthLogin: () => ipcRenderer.invoke('feishu:auth-login'),
  feishuAuthStatus: () => ipcRenderer.invoke('feishu:auth-status'),
  feishuEventStart: () => ipcRenderer.invoke('feishu:event-start'),
  feishuEventStop: () => ipcRenderer.invoke('feishu:event-stop'),
  feishuEventStatus: () => ipcRenderer.invoke('feishu:event-status'),
  feishuPendingConfirms: () => ipcRenderer.invoke('feishu:pending-confirms'),
  feishuCancelConfirm: (id) => ipcRenderer.invoke('feishu:cancel-confirm', id),
  feishuAuditTail: (limit) => ipcRenderer.invoke('feishu:audit-tail', limit),
  feishuAuditQuery: (opts) => ipcRenderer.invoke('feishu:audit-query', opts),
  feishuHealthCheck: () => ipcRenderer.invoke('feishu:health-check'),
  feishuCheckCliUpdate: () => ipcRenderer.invoke('feishu:check-cli-update'),
  feishuOnConfigInitProgress: (cb: (data: { line: string }) => void) => {
    const fn = (_e: unknown, data: { line: string }) => cb(data)
    ipcRenderer.on('feishu:config-init-progress', fn)
    return () => ipcRenderer.removeListener('feishu:config-init-progress', fn)
  },
  feishuOnInboundMessage: (cb) => {
    const fn = (_e: unknown, data: { sessionId: string; message: unknown }) => cb(data)
    ipcRenderer.on('feishu:inbound-message', fn)
    return () => ipcRenderer.removeListener('feishu:inbound-message', fn)
  },
  feishuOnRemoteAgentStart: (cb) => {
    const fn = (_e: unknown, data: { sessionId: string; assistantMessageId: string; requestId: string }) => cb(data)
    ipcRenderer.on('feishu:remote-agent-start', fn)
    return () => ipcRenderer.removeListener('feishu:remote-agent-start', fn)
  },
  feishuOnPendingConfirm: (cb) => {
    const fn = (_e: unknown, data: { sessionId: string; pendingConfirm: boolean }) => cb(data)
    ipcRenderer.on('feishu:pending-confirm', fn)
    return () => ipcRenderer.removeListener('feishu:pending-confirm', fn)
  },
  feishuOnAgentDone: (cb) => {
    const fn = (
      _e: unknown,
      data: { sessionId: string; messageId: string; requestId: string; ok: boolean; summary?: string }
    ) => cb(data)
    ipcRenderer.on('feishu:agent-done', fn)
    return () => ipcRenderer.removeListener('feishu:agent-done', fn)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type { AppConfig, FileInfo, Message, SearchResult, Session }
