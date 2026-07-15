import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, FileInfo, Message, SearchResult, Session } from '../src/shared/domainTypes'
import type { ClaudeChatCreateWithToolsPayload, ClaudeChatSendStreamPayload, SpaceAssistantApi } from '../src/shared/api'

const api: SpaceAssistantApi = {
  ping: () => ipcRenderer.invoke('ping'),
  appOpenExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionCreate: (payload) => ipcRenderer.invoke('session:create', payload),
  sessionGet: (sessionId) => ipcRenderer.invoke('session:get', sessionId),
  sessionUpdate: (payload) => ipcRenderer.invoke('session:update', payload),
  sessionBackfillAutoTitleIfNeeded: (payload: { sessionId: string }) =>
    ipcRenderer.invoke('session:backfill-auto-title-if-needed', payload) as Promise<Session | undefined>,
  sessionDelete: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),

  usageSet: (payload) => ipcRenderer.invoke('usage:set', payload),
  usageGet: (sessionId) => ipcRenderer.invoke('usage:get', sessionId),
  usageDelete: (sessionId) => ipcRenderer.invoke('usage:delete', sessionId),

  chatGetMessages: (payload) => ipcRenderer.invoke('chat:get-messages', payload),
  chatAppendMessage: (msg) => ipcRenderer.invoke('chat:append-message', msg),
  chatPatchMessage: (payload) => ipcRenderer.invoke('chat:patch-message', payload),
  chatDeleteQueuedMessage: (payload: { messageId: string; sessionId: string }) =>
    ipcRenderer.invoke('chat:delete-queued-message', payload) as Promise<
      { ok: true; sessionId: string } | { ok: false; error: string }
    >,

  chatStageImage: (args) => ipcRenderer.invoke('chat:stage-image', args),
  chatDiscardStagedImage: (args) => ipcRenderer.invoke('chat:discard-staged-image', args),
  chatReadStagedImage: (args) => ipcRenderer.invoke('chat:read-staged-image', args),

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
    const fn = (_e: unknown, data: { requestId: string; usage?: unknown }) => cb(data)
    ipcRenderer.on('claude-chat-done', fn)
    return () => ipcRenderer.removeListener('claude-chat-done', fn)
  },
  claudeChatOnUsage: (cb) => {
    const fn = (
      _e: unknown,
      data: {
        requestId: string
        sessionId: string
        usage: import('../src/shared/sessionUsage').SessionUsage
        projected?: boolean
      }
    ) => cb(data)
    ipcRenderer.on('claude-chat-usage', fn)
    return () => ipcRenderer.removeListener('claude-chat-usage', fn)
  },
  claudeChatOnError: (cb) => {
    const fn = (_e: unknown, data: { requestId: string; message: string }) => cb(data)
    ipcRenderer.on('claude-chat-error', fn)
    return () => ipcRenderer.removeListener('claude-chat-error', fn)
  },
  claudeChatCancel: (payload) => ipcRenderer.invoke('claude-chat-cancel', payload),

  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (payload) => ipcRenderer.invoke('config:set', payload),
  configTestConnection: (options?: {
    serviceId?: string
    apiKey?: string
    baseUrl?: string
    supportedModelIds?: string[]
  }) =>
    ipcRenderer.invoke('config:test-connection', options),

  dialogSelectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  configCheckWorkdirWritable: (dir) => ipcRenderer.invoke('config:check-workdir-writable', dir),

  fileListDirectory: (relPath) => ipcRenderer.invoke('file:list-directory', relPath),
  fileReadFile: (relPath) => ipcRenderer.invoke('file:read-file', relPath),
  fileGetMetadata: (relPath) => ipcRenderer.invoke('file:get-metadata', relPath),
  fileToViewerUrl: (relPath) => ipcRenderer.invoke('file:to-viewer-url', relPath),
  fileOpenInSystem: (relPath) => ipcRenderer.invoke('file:open-in-system', relPath),
  fileShowInExplorer: (relPath) => ipcRenderer.invoke('file:show-in-explorer', relPath),
  fileExportPdf: (payload) => ipcRenderer.invoke('file:export-pdf', payload),
  fileCreateFile: (relPath) => ipcRenderer.invoke('file:create-file', relPath),
  fileCreateDirectory: (relPath) => ipcRenderer.invoke('file:create-directory', relPath),
  fileDelete: (relPath) => ipcRenderer.invoke('file:delete', relPath),
  fileRename: (relPath, newName) => ipcRenderer.invoke('file:rename', relPath, newName),
  fileMove: (srcRelPath, destDirRelPath) => ipcRenderer.invoke('file:move', srcRelPath, destDirRelPath),
  fileCopy: (payload) => ipcRenderer.invoke('file:copy', payload),
  fileOnTreeChanged: (cb) => {
    const fn = (_e: unknown, data: import('../src/shared/fileTreeSync').FileTreeChangeEvent) => cb(data)
    ipcRenderer.on('file:tree-changed', fn)
    return () => ipcRenderer.removeListener('file:tree-changed', fn)
  },
  fileWatchContent: (relPath) => ipcRenderer.invoke('file:watch-content', { relPath }),
  fileOnContentChanged: (cb) => {
    const fn = (_e: unknown, data: import('../src/shared/fileContentSync').FileContentChangedEvent) => cb(data)
    ipcRenderer.on('file:content-changed', fn)
    return () => ipcRenderer.removeListener('file:content-changed', fn)
  },

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

  windowGetPlatform: () => ipcRenderer.invoke('window:get-platform'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowOnMaximizeChanged: (cb) => {
    const fn = (_e: unknown, isMaximized: boolean) => cb(isMaximized)
    ipcRenderer.on('window:maximize-changed', fn)
    return () => ipcRenderer.removeListener('window:maximize-changed', fn)
  },
  appQuit: () => ipcRenderer.invoke('app:quit'),
  appToggleDevTools: () => ipcRenderer.invoke('app:toggle-devtools'),

  sessionOnTitleGenerated: (cb) => {
    const fn = (_e: unknown, data: { session: Session }) => cb(data)
    ipcRenderer.on('session:title-generated', fn)
    return () => ipcRenderer.removeListener('session:title-generated', fn)
  },

  toolConfirmResponse: (payload: import('../src/shared/api').ToolConfirmResponsePayload) =>
    ipcRenderer.invoke('tool:confirm-response', payload),
  fileWriteDirOnConfirmRequest: (cb) => {
    const fn = (_e: unknown, data: import('../src/shared/api').WriteDirConfirmRequest) => cb(data)
    ipcRenderer.on('file-write-dir:confirm-request', fn)
    return () => ipcRenderer.removeListener('file-write-dir:confirm-request', fn)
  },
  fileWriteDirConfirmResponse: (payload: import('../src/shared/api').WriteDirConfirmResponse) =>
    ipcRenderer.invoke('file-write-dir:confirm-response', payload),
  fileWriteDirReset: (payload: { sessionId: string }) => ipcRenderer.invoke('file-write-dir:reset', payload),
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
        sessionId?: string
        toolUseId: string
        toolName: string
        input: unknown
        riskLevel: 'low' | 'medium' | 'high'
        diff?: { oldContent: string; newContent: string; oldPath: string }
        shellSecurityHints?: import('../src/shared/domainTypes').ShellSecurityHints
        autoApproveFallback?: import('../src/shared/domainTypes').AutoApproveFallback
        currentPageUrl?: string
        dangerInfo?: import('../src/shared/domainTypes').BrowserActDangerInfo
        sessionTrustedHint?: true
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
  shellManageTrustedCommands: (payload) => ipcRenderer.invoke('shell:manage-trusted-commands', payload),

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
  feishuOwnerBindStatus: () => ipcRenderer.invoke('feishu:owner-bind-status'),
  feishuOwnerBeginBind: () => ipcRenderer.invoke('feishu:owner-begin-bind'),
  feishuOwnerRebind: () => ipcRenderer.invoke('feishu:owner-rebind'),
  feishuOwnerBindCancel: () => ipcRenderer.invoke('feishu:owner-bind-cancel'),
  feishuOwnerClear: () => ipcRenderer.invoke('feishu:owner-clear'),
  remoteSecurityPlan: () => ipcRenderer.invoke('remote-security:plan'),
  remoteSecurityCommit: (patch) => ipcRenderer.invoke('remote-security:commit', patch),
  feishuOnOwnerBound: (cb) => {
    const fn = (_e: unknown, data: { maskedOwnerOpenId?: string; boundAt?: number }) => cb(data)
    ipcRenderer.on('feishu:owner-bound', fn)
    return () => ipcRenderer.removeListener('feishu:owner-bound', fn)
  },
  feishuOnConfigInitProgress: (cb: (data: { line: string }) => void) => {
    const fn = (_e: unknown, data: { line: string }) => cb(data)
    ipcRenderer.on('feishu:config-init-progress', fn)
    return () => ipcRenderer.removeListener('feishu:config-init-progress', fn)
  },
  feishuOnConfigChanged: (cb) => {
    const fn = (_e: unknown, data: { feishu: import('../src/shared/feishuTypes').FeishuConfig }) => cb(data)
    ipcRenderer.on('feishu:config-changed', fn)
    return () => ipcRenderer.removeListener('feishu:config-changed', fn)
  },
  feishuOnBindTimeout: (cb) => {
    const fn = () => cb()
    ipcRenderer.on('feishu:bind-timeout', fn)
    return () => ipcRenderer.removeListener('feishu:bind-timeout', fn)
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

  wechatDetectSdk: () => ipcRenderer.invoke('wechat:detect-sdk'),
  wechatLoginStart: (opts) => ipcRenderer.invoke('wechat:login-start', opts),
  wechatLoginStop: () => ipcRenderer.invoke('wechat:login-stop'),
  wechatSubmitVerifyCode: (code) => ipcRenderer.invoke('wechat:submit-verify-code', code),
  wechatLogout: () => ipcRenderer.invoke('wechat:logout'),
  wechatConnectionStatus: () => ipcRenderer.invoke('wechat:connection-status'),
  wechatPollStart: () => ipcRenderer.invoke('wechat:poll-start'),
  wechatPollStop: () => ipcRenderer.invoke('wechat:poll-stop'),
  wechatPendingConfirms: () => ipcRenderer.invoke('wechat:pending-confirms'),
  wechatConfirmResponse: (payload) => ipcRenderer.invoke('wechat:confirm-response', payload),
  wechatAuditTail: (limit) => ipcRenderer.invoke('wechat:audit-tail', limit),
  wechatAuditQuery: (opts) => ipcRenderer.invoke('wechat:audit-query', opts),
  wechatSend: (payload) => ipcRenderer.invoke('wechat:send', payload),
  wechatReply: (payload) => ipcRenderer.invoke('wechat:reply', payload),
  wechatOnQrUrl: (cb) => {
    const fn = (_e: unknown, data: { url: string | null; expired?: boolean }) => cb(data)
    ipcRenderer.on('wechat:qr-url', fn)
    return () => ipcRenderer.removeListener('wechat:qr-url', fn)
  },
  wechatOnLoginProgress: (cb) => {
    const fn = (_e: unknown, data: { stage: string; code?: string; isRetry?: boolean }) =>
      cb(data as {
        stage: import('../src/shared/wechatTypes').WeChatLoginProgress
        code?: string
        isRetry?: boolean
      })
    ipcRenderer.on('wechat:login-progress', fn)
    return () => ipcRenderer.removeListener('wechat:login-progress', fn)
  },
  wechatOnInboundMessage: (cb) => {
    const fn = (_e: unknown, data: { sessionId: string; message: unknown }) => cb(data)
    ipcRenderer.on('wechat:inbound-message', fn)
    return () => ipcRenderer.removeListener('wechat:inbound-message', fn)
  },
  wechatOnRemoteAgentStart: (cb) => {
    const fn = (_e: unknown, data: { sessionId: string; assistantMessageId: string; requestId: string }) => cb(data)
    ipcRenderer.on('wechat:remote-agent-start', fn)
    return () => ipcRenderer.removeListener('wechat:remote-agent-start', fn)
  },
  wechatOnConfirmRequest: (cb) => {
    const fn = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('wechat:confirm-request', fn)
    return () => ipcRenderer.removeListener('wechat:confirm-request', fn)
  },
  wechatOnPendingConfirm: (cb) => {
    const fn = (_e: unknown, data: { count: number }) => cb(data)
    ipcRenderer.on('wechat:pending-confirm', fn)
    return () => ipcRenderer.removeListener('wechat:pending-confirm', fn)
  },
  wechatOnAgentDone: (cb) => {
    const fn = (
      _e: unknown,
      data: { sessionId: string; messageId: string; requestId: string; ok: boolean; summary?: string }
    ) => cb(data)
    ipcRenderer.on('wechat:agent-done', fn)
    return () => ipcRenderer.removeListener('wechat:agent-done', fn)
  },
  wechatOnPollingStats: (cb) => {
    const fn = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('wechat:polling-stats', fn)
    return () => ipcRenderer.removeListener('wechat:polling-stats', fn)
  },

  workdirList: () => ipcRenderer.invoke('workdir:list'),
  workdirAdd: (profile) => ipcRenderer.invoke('workdir:add', profile),
  workdirUpdate: (profileId, updates) => ipcRenderer.invoke('workdir:update', { profileId, updates }),
  workdirRemove: (profileId) => ipcRenderer.invoke('workdir:remove', { profileId }),
  workdirSwitch: (profileId) => ipcRenderer.invoke('workdir:switch', { profileId }),
  workdirCheckWritable: (path) => ipcRenderer.invoke('workdir:check-writable', { path }),

  onRemoteSwitchSessionRequest: (cb) => {
    const fn = (_e: unknown, data: { requestId: string; sessionId: string }) => cb(data)
    ipcRenderer.on('remote:switch-session-request', fn)
    return () => ipcRenderer.removeListener('remote:switch-session-request', fn)
  },
  remoteSwitchSessionComplete: (payload: {
    requestId: string
    desktopSwitched: boolean
    viewChanged: boolean
  }) => ipcRenderer.invoke('remote:switch-session-complete', payload),

  testPopShow: () => ipcRenderer.invoke('test-pop:show')
}

contextBridge.exposeInMainWorld('api', api)

export type { AppConfig, FileInfo, Message, SearchResult, Session }
