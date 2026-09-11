import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, FileInfo, Message, SearchResult, Session } from '../src/shared/domainTypes'
import type { SpaceAssistantApi, TurnExecutePayload } from '../src/shared/api'

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
  chatGetApiContextBaseline: (payload) => ipcRenderer.invoke('chat:get-api-context-baseline', payload),
  chatGetMessagePage: (payload) => ipcRenderer.invoke('chat:get-message-page', payload),
  chatGetContextHistorySummaryBaseline: (payload) =>
    ipcRenderer.invoke('chat:get-context-history-summary-baseline', payload),
  chatGetSearchCorpusPage: (payload) => ipcRenderer.invoke('chat:get-search-corpus-page', payload),
  chatGetNextQueuedMessage: (payload) => ipcRenderer.invoke('chat:get-next-queued-message', payload),
  chatEnqueueQueuedMessage: (payload) => ipcRenderer.invoke('chat:enqueue-queued-message', payload),
  chatResolveRetryContext: (payload) => ipcRenderer.invoke('chat:resolve-retry-context', payload),
  chatGetMessageSequence: (payload) => ipcRenderer.invoke('chat:get-message-sequence', payload),
  messageAppendNonTurn: (msg) => ipcRenderer.invoke('message:append-non-turn', msg),
  messagePatchNonTurn: (payload) => ipcRenderer.invoke('message:patch-non-turn', payload),
  chatPrepareTurn: (intent) => ipcRenderer.invoke('chat:prepare-turn', intent),
  chatExecuteTurn: (payload: TurnExecutePayload) => ipcRenderer.invoke('chat:execute-turn', payload),
  chatCancelTurn: (turnId) => ipcRenderer.invoke('chat:cancel-turn', turnId),
  chatGetTurnTerminal: (turnId) => ipcRenderer.invoke('chat:get-turn-terminal', turnId),
  chatListActiveTurns: (payload) => ipcRenderer.invoke('chat:list-active-turns', payload),
  chatOnTurnProjection: (cb) => {
    const fn = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
    ipcRenderer.on('chat:turn-projection', fn)
    return () => ipcRenderer.removeListener('chat:turn-projection', fn)
  },
  chatDeleteQueuedMessage: (payload: { messageId: string; sessionId: string }) =>
    ipcRenderer.invoke('chat:delete-queued-message', payload) as Promise<
      { ok: true; sessionId: string } | { ok: false; error: string }
    >,

  chatStageImage: (args) => ipcRenderer.invoke('chat:stage-image', args),
  chatDiscardStagedImage: (args) => ipcRenderer.invoke('chat:discard-staged-image', args),
  chatReadStagedImage: (args) => ipcRenderer.invoke('chat:read-staged-image', args),

  configGet: () => ipcRenderer.invoke('config:get'),
  getToolExposureList: (payload) => ipcRenderer.invoke('exposure:get-tools', payload),

  // ===== 「安全策略」设置页（§7 五区，P4）=====
  securityGetSettingsModel: () => ipcRenderer.invoke('security:get-settings-model'),
  securitySetPolicyPackage: (payload) => ipcRenderer.invoke('security:set-policy-package', payload),
  securitySetRuleOverride: (payload) => ipcRenderer.invoke('security:set-rule-override', payload),
  securitySetRuleEnabled: (payload) => ipcRenderer.invoke('security:set-rule-enabled', payload),
  securityRemoveRuleOverride: (payload) => ipcRenderer.invoke('security:remove-rule-override', payload),
  securityListDecisionCache: () => ipcRenderer.invoke('security:list-cache'),
  securityClearDecisionCache: (payload) => ipcRenderer.invoke('security:clear-cache', payload),
  securityQueryAudit: (query) => ipcRenderer.invoke('security:query-audit', query),
  securityGetAuditRetention: () => ipcRenderer.invoke('security:get-audit-retention'),
  securitySetAuditRetention: (payload) => ipcRenderer.invoke('security:set-audit-retention', payload),
  onToolExposureChanged: (cb) => {
    const fn = (_e: unknown, payload: { lane: 'desktop' | 'wechat' | 'feishu'; tools: string[] }) => cb(payload)
    ipcRenderer.on('exposure:tools-changed', fn)
    return () => ipcRenderer.removeListener('exposure:tools-changed', fn)
  },
  configSet: (payload) => ipcRenderer.invoke('config:set', payload),
  configTestConnection: (options?: {
    serviceId?: string
    apiKey?: string
    baseUrl?: string
    supportedModelIds?: string[]
    models?: import('../src/shared/domainTypes').ModelEntry[]
  }) =>
    ipcRenderer.invoke('config:test-connection', options),
  llmFetchServiceModels: (options?: { serviceId?: string; apiKey?: string; baseUrl?: string }) =>
    ipcRenderer.invoke('llm:fetch-service-models', options),

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
  toolCancel: (payload) => ipcRenderer.invoke('tool:cancel', payload),
  toolTestInterpreter: (payload) => ipcRenderer.invoke('tool:test-interpreter', payload),
  shellTestExecutable: (payload: { executable?: string; argsPrefix?: string[] }) =>
    ipcRenderer.invoke('shell:test-executable', payload),
  shellOpenOutputPath: (absPath: string) => ipcRenderer.invoke('shell:open-output-path', absPath),
  shellOpenTerminal: (payload: { cwd: string }) => ipcRenderer.invoke('shell:open-terminal', payload),
  shellManageTrustedCommands: (payload) => ipcRenderer.invoke('shell:manage-trusted-commands', payload),

  browserDetect: (force?: boolean) => ipcRenderer.invoke('browser:detect', force),
  browserOpenTerminal: () => ipcRenderer.invoke('browser:open-terminal'),

  skillList: () => ipcRenderer.invoke('skill:list'),
  skillProbeFromUrl: (payload) => ipcRenderer.invoke('skill:probe-github-url', payload),
  skillInstallOnProgress: (cb: (progress: { phase: string; completed?: number; total?: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { phase: string; completed?: number; total?: number }) => cb(data)
    ipcRenderer.on('skill-install-progress', listener)
    return () => ipcRenderer.removeListener('skill-install-progress', listener)
  },
  skillCancelInstall: () => ipcRenderer.invoke('skill:cancel-install'),
  skillScanStatus: () => ipcRenderer.invoke('skill:scan-status'),
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
  feishuOnPendingConfirm: (cb) => {
    const fn = (_e: unknown, data: { sessionId: string; pendingConfirm: boolean }) => cb(data)
    ipcRenderer.on('feishu:pending-confirm', fn)
    return () => ipcRenderer.removeListener('feishu:pending-confirm', fn)
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

  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSaveProfiles: (payload) => ipcRenderer.invoke('mcp:save-profiles', payload),
  mcpTestConnection: (payload) => ipcRenderer.invoke('mcp:test-connection', payload),
  mcpRefreshTools: (payload) => ipcRenderer.invoke('mcp:refresh-tools', payload),
  mcpClearSecret: (payload) => ipcRenderer.invoke('mcp:clear-secret', payload),
  mcpDeleteServer: (payload) => ipcRenderer.invoke('mcp:delete-server', payload),
  mcpGetDiagnostics: (payload) => ipcRenderer.invoke('mcp:get-diagnostics', payload),
  mcpClearDiagnostics: (payload) => ipcRenderer.invoke('mcp:clear-diagnostics', payload),
  mcpOauthStart: (payload) => ipcRenderer.invoke('mcp:oauth-start', payload),

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
