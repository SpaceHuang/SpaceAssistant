import type { AppLocale } from './locale'
import type {
  AppConfig,
  AutoApproveFallback,
  BrowserActDangerInfo,
  ChatImageAttachment,
  FileInfo,
  Message,
  ProjectMemoryState,
  SearchResult,
  Session,
  SkillRouteRecentMessage,
  SkillRouteResult,
  SessionSkillsState,
  SkillDefinition,
  SkillsConfig,
  ToolCallResultPersisted,
  ToolRiskLevel,
  ToolsConfig,
  ShellConfig,
  ShellSecurityHints,
  TrustedShellCommand,
  WikiConfig,
  WikiStatus,
  WorkspaceLayoutConfig
} from './domainTypes'

export type ToolConfirmResponsePayload = {
  requestId: string
  toolUseId: string
  approved: boolean
  trustCommand?: string
  trustDomain?: string
  trustActDomain?: string
}

export type WriteDirCandidateLabelKind = 'recentSession'

export interface WriteDirCandidatePayload {
  key: string
  dir: string
  /** 相对 workDir 的路径展示（如 `Script` 或 `.`） */
  label: string
  labelKind?: WriteDirCandidateLabelKind
}

export interface WriteDirConfirmRequest {
  requestId: string
  sessionId: string
  candidates: WriteDirCandidatePayload[]
  customOption: true
}

export type WriteDirConfirmChoice =
  | { type: 'candidate'; key: string }
  | { type: 'custom'; dir: string }

export interface WriteDirConfirmResponse {
  requestId: string
  sessionId: string
  choice: WriteDirConfirmChoice | null
}

export type ShellManageTrustedCommandsAction =
  | { action: 'list' }
  | { action: 'add'; command: string }
  | { action: 'remove'; ids: string[] }
  | { action: 'cleanExpired' }
import type {
  FeishuCliDetectResult,
  FeishuConfig,
  FeishuEventStatus,
  FeishuHealthCheck,
  FeishuAuditEvent,
  FeishuAuditQueryResult,
  FeishuPendingConfirmSummary,
  FeishuOwnerBindSnapshot,
  FeishuBindWindowResult,
  WorkDirProfile
} from './feishuTypes'
import type {
  WeChatAuditEvent,
  WeChatAuditQueryResult,
  WeChatConfig,
  WeChatConnectionStatus,
  WeChatLoginProgress,
  WeChatSdkDetectResult
} from './wechatTypes'
import type {
  RemoteSecurityCommitResult,
  RemoteSecurityMigrationPlan,
  RemoteSecurityPatch
} from './remoteSecurityMigration'
import type {
  BrowserDetectResult,
  BrowserDependencyFailureCode,
  BrowserDependencyToolError
} from './browserTypes'
import type { SessionUsage } from './sessionUsage'

export type {
  BrowserDetectResult,
  BrowserDependencyFailureCode,
  BrowserDependencyToolError
} from './browserTypes'

export type FileViewerUrlResult = { ok: true; url: string } | { ok: false; error: string }

export type FileReadResult =
  | { kind: 'text'; content: string; encoding: 'utf8' }
  | { kind: 'image'; content: string; encoding: 'base64'; mimeType: string }
  | { kind: 'unsupported'; ext: string }
  | { kind: 'too_large'; size: number }

export type FileMetadata = {
  size: number
  mtime: number
  isText: boolean
}

export type ArtifactApiItem = {
  id: string
  sessionId: string
  container: 'project' | 'package' | 'scratch'
  role: 'primary' | 'supporting' | 'reference' | 'scratch'
  title: string
  finalPath: string
  status: 'active' | 'deleted'
  stage?: 'working' | 'draft' | 'final'
  packageId?: string
}

export type ArtifactDecisionResponsePayload = {
  decisionId: string
  requestId: string
  sessionId: string
  toolUseId: string
  attempt: number
  choice: string
}

export type ClaudeChatSendStreamPayload = {
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  system?: string
  /** 未传时主进程使用内置默认；建议传渲染侧解析后的有效值 */
  maxTokens?: number
  projectMemoryEnabled?: boolean
  locale?: AppLocale
}

export type ClaudeChatMessageWithBlocks = {
  role: 'user' | 'assistant'
  content: string | unknown[]
  id?: string
  timestamp?: number
}

export type ClaudeChatCreateWithToolsPayload = {
  requestId: string
  sessionId: string
  model: string
  baseUrl?: string
  /** 指定 API 服务 id，主进程据此解析 Key */
  llmServiceId?: string
  /** 领域消息（含 attachments 元数据，无 base64）；主进程 build */
  sourceMessages: Message[]
  /** 本次 invoke 的当轮 user 消息 id */
  currentUserMessageId: string
  /** @deprecated 渲染进程预 build；保留类型兼容，主进程不消费 */
  messages?: ClaudeChatMessageWithBlocks[]
  tools: Array<Record<string, unknown>>
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  projectMemoryEnabled?: boolean
  locale?: AppLocale
  /** P1：临时视觉路由时上下文环分母修正 */
  effectiveModelForUsage?: string
}

export type SpaceAssistantApi = {
  ping: () => Promise<string>

  appOpenExternal: (url: string) => Promise<{ ok: true } | { ok: false; error: string }>

  sessionList: () => Promise<Session[]>
  sessionCreate: (payload: {
    name: string
    model?: string
    llmServiceId?: string
    temperature?: number
    maxTokens?: number
    metadata?: Record<string, unknown>
  }) => Promise<Session>
  sessionGet: (sessionId: string) => Promise<Session | undefined>
  sessionUpdate: (payload: {
    sessionId: string
    name?: string
    model?: string
    llmServiceId?: string
    temperature?: number
    maxTokens?: number
    skillsState?: SessionSkillsState
    metadata?: Record<string, unknown>
  }) => Promise<Session | undefined>
  sessionBackfillAutoTitleIfNeeded: (payload: { sessionId: string }) => Promise<Session | undefined>
  sessionDelete: (sessionId: string) => Promise<void>

  artifactList: (payload: { sessionId: string }) => Promise<ArtifactApiItem[]>
  artifactDecisionResponse: (payload: ArtifactDecisionResponsePayload) => Promise<void>
  artifactDelete: (payload: { sessionId: string; artifactId: string }) => Promise<{ ok: boolean; error?: string }>
  artifactCleanSession: (payload: { sessionId: string; includeReferences?: boolean }) => Promise<{ deleted: string[]; skipped: Array<{ artifactId: string; reason: string }> }>
  artifactRelocate: (payload: { sessionId: string; artifactId: string; target: string; mode: 'move' | 'copy' }) => Promise<{ ok: boolean; error?: string }>
  artifactSetDefaultDir: (payload: { sessionId: string; dir: string }) => Promise<void>
  artifactOnChanged: (cb: (event: { sessionId: string; artifactId: string; action: 'created' | 'updated' | 'deleted' }) => void) => () => void

  usageSet: (payload: { sessionId: string; usage: SessionUsage }) => Promise<void>
  usageGet: (sessionId: string) => Promise<SessionUsage | undefined>
  usageDelete: (sessionId: string) => Promise<void>

  chatGetMessages: (payload: { sessionId: string; limit?: number; offset?: number }) => Promise<Message[]>
  chatAppendMessage: (msg: Message) => Promise<Message>
  chatPatchMessage: (payload: {
    messageId: string
    sessionId: string
    patch: Partial<
      Pick<
        Message,
        | 'content'
        | 'status'
        | 'toolUse'
        | 'thinking'
        | 'toolCalls'
        | 'contentSegments'
        | 'skillHints'
        | 'attachments'
        | 'imagesDeliveredToApi'
      >
    >
  }) => Promise<void>
  chatDeleteQueuedMessage: (payload: {
    messageId: string
    sessionId: string
  }) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>

  chatStageImage: (args: {
    sessionId: string
    fileName: string
    mimeType: string
    dataBase64: string
  }) => Promise<ChatImageAttachment | { error: string }>
  chatDiscardStagedImage: (args: {
    sessionId: string
    stagingKey: string
  }) => Promise<{ ok: true } | { error: string }>
  chatReadStagedImage: (args: {
    sessionId: string
    stagingKey: string
    maxBytes?: number
  }) => Promise<{ mimeType: string; dataBase64: string } | { error: string }>

  claudeChatSendStream: (payload: ClaudeChatSendStreamPayload) => Promise<{ ok: true } | { ok: false; error: string }>
  claudeChatCreateWithTools: (
    payload: ClaudeChatCreateWithToolsPayload
  ) => Promise<
    | { ok: true; content: unknown[]; stopReason: string; usage?: unknown }
    | { ok: false; error: string; usage?: unknown }
  >
  claudeChatOnDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
  claudeChatOnThinkingDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
  claudeChatOnDone: (cb: (data: { requestId: string; usage?: unknown }) => void) => () => void
  claudeChatOnUsage: (
    cb: (data: { requestId: string; sessionId: string; usage: SessionUsage; projected?: boolean }) => void
  ) => () => void
  claudeChatOnError: (cb: (data: { requestId: string; message: string }) => void) => () => void
  claudeChatCancel: (payload: { requestId: string }) => Promise<void>

  configGet: () => Promise<AppConfig>
  configSet: (
    payload: Partial<{
      baseUrl: string
      model: string
      defaultModel: string
      models: import('./domainTypes').ModelEntry[]
      thinkingEnabled: boolean
      workDir: string
      apiKey: string
      llmServices: import('./domainTypes').LlmServiceProfile[]
        activeLlmServiceId?: string
        activeLlmServiceIds?: string[]
        preferredLanguageModelId?: string
        preferredFastLanguageModelId?: string
        preferredVisionModelId?: string
        llmServiceKeys?: Record<string, string>
      tools: Partial<ToolsConfig>
      skills: Partial<SkillsConfig>
      wiki: Partial<WikiConfig>
      feishu: Partial<FeishuConfig>
      wechat: Partial<WeChatConfig>
      workDirProfiles: WorkDirProfile[]
      activeWorkDirProfileId: string
      maxParallelChatSessions: number
      browser: Partial<import('./domainTypes').BrowserConfig>
      shell: Partial<ShellConfig>
      locale: import('./domainTypes').AppLocale
      workspaceLayout: Partial<WorkspaceLayoutConfig>
    }>
  ) => Promise<void>
  configTestConnection: (options?: {
    serviceId?: string
    apiKey?: string
    baseUrl?: string
    /** 设置页草稿中的支持模型 id；未保存时须传入 */
    supportedModelIds?: string[]
  }) => Promise<{ success: boolean; error?: string }>

  dialogSelectDirectory: () => Promise<{ path: string } | { canceled: true } | { error: string }>
  configCheckWorkdirWritable: (dir: string) => Promise<{ writable: boolean; error?: string }>

  fileListDirectory: (relPath: string) => Promise<FileInfo[]>
  fileReadFile: (relPath: string) => Promise<FileReadResult>
  fileGetMetadata: (relPath: string) => Promise<FileMetadata>
  fileToViewerUrl: (relPath: string) => Promise<FileViewerUrlResult>
  fileOpenInSystem: (relPath: string) => Promise<{ ok: true } | { ok: false; error: string }>
  fileShowInExplorer: (relPath: string) => Promise<{ ok: true } | { ok: false; error: string }>
  fileExportPdf: (payload: {
    htmlContent: string
    defaultPath: string
  }) => Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }>
  fileCreateFile: (relPath: string) => Promise<void>
  fileCreateDirectory: (relPath: string) => Promise<void>
  fileDelete: (relPath: string) => Promise<void>
  fileRename: (relPath: string, newName: string) => Promise<void>
  fileMove: (srcRelPath: string, destDirRelPath: string) => Promise<void>
  fileCopy: (payload: { srcRelPath: string; destRelPath: string }) => Promise<void>
  fileOnTreeChanged: (cb: (event: import('./fileTreeSync').FileTreeChangeEvent) => void) => () => void
  fileWatchContent: (relPath: string | null) => Promise<void>
  fileOnContentChanged: (cb: (event: import('./fileContentSync').FileContentChangedEvent) => void) => () => void

  searchExecute: (query: string) => Promise<SearchResult[]>
  searchGetHistory: () => Promise<string[]>

  onOpenSettings: (cb: () => void) => () => void
  onOpenAbout: (cb: () => void) => () => void

  windowGetPlatform: () => Promise<NodeJS.Platform>
  windowIsMaximized: () => Promise<boolean>
  windowMinimize: () => Promise<void>
  windowMaximizeToggle: () => Promise<boolean>
  windowClose: () => Promise<void>
  windowOnMaximizeChanged: (cb: (isMaximized: boolean) => void) => () => void
  appQuit: () => Promise<void>
  appToggleDevTools: () => Promise<void>

  sessionOnTitleGenerated: (cb: (data: { session: Session }) => void) => () => void

  toolConfirmResponse: (payload: ToolConfirmResponsePayload) => Promise<void>
  fileWriteDirOnConfirmRequest: (cb: (data: WriteDirConfirmRequest) => void) => () => void
  fileWriteDirConfirmResponse: (
    payload: WriteDirConfirmResponse
  ) => Promise<{ ok: true } | { ok: false; error?: string }>
  fileWriteDirReset: (payload: { sessionId: string }) => Promise<{ ok: true } | { ok: false; error?: string }>
  toolCancel: (payload: { requestId: string; toolUseId: string }) => Promise<void>
  toolOnUse: (cb: (data: { requestId: string; toolUse: { id: string; name: string; input: unknown } }) => void) => () => void
  toolOnRedirect: (
    cb: (data: { requestId: string; toolUseId: string; originalPath: string; newPath: string }) => void
  ) => () => void
  toolOnPathResolved: (
    cb: (data: {
      requestId: string
      toolUseId: string
      path: string
      metadata: import('./artifactTypes').ArtifactToolResultMeta
    }) => void
  ) => () => void
  toolOnConfirmRequest: (
    cb: (data: {
      requestId: string
      sessionId?: string
      toolUseId: string
      toolName: string
      input: unknown
      riskLevel: ToolRiskLevel
      diff?: { oldContent: string; newContent: string; oldPath: string }
      shellSecurityHints?: ShellSecurityHints
      autoApproveFallback?: AutoApproveFallback
      currentPageUrl?: string
      dangerInfo?: BrowserActDangerInfo
      sessionTrustedHint?: true
    }) => void
  ) => () => void
  toolOnProgress: (
    cb: (data: {
      requestId: string
      toolUseId: string
      status: string
      message?: string
      raw?: string
      seq?: number
    }) => void
  ) => () => void
  shellOpenTerminal: (payload: { cwd: string }) => Promise<{ ok: true } | { ok: false; error: string }>
  shellManageTrustedCommands: (
    payload: ShellManageTrustedCommandsAction
  ) => Promise<{ ok: true; commands: TrustedShellCommand[] } | { ok: false; error: string }>
  toolOnResult: (
    cb: (data: { requestId: string; toolUseId: string; result: ToolCallResultPersisted }) => void
  ) => () => void
  toolTestInterpreter: (payload: { path: string }) => Promise<{ ok: true; version: string } | { ok: false; error: string }>
  shellTestExecutable: (payload: {
    executable?: string
    argsPrefix?: string[]
  }) => Promise<{ ok: boolean; error?: string }>
  shellOpenOutputPath: (absPath: string) => Promise<{ ok: true } | { ok: false; error: string }>

  skillList: () => Promise<SkillDefinition[]>
  skillGet: (payload: { name: string }) => Promise<SkillDefinition | null>
  skillInstall: (payload: { sourcePath: string; overwrite?: boolean }) => Promise<{ ok: true; skill: SkillDefinition } | { ok: false; error: string }>
  skillInstallFromUrl: (payload: {
    sourceUrl: string
    subPath?: string
    installAll?: boolean
    overwrite?: boolean
  }) => Promise<{ ok: true; skills: SkillDefinition[] } | { ok: false; error: string }>
  skillDelete: (payload: { name: string }) => Promise<void>
  skillToggleDisable: (payload: { name: string; disabled: boolean }) => Promise<void>
  skillOpenDirectory: (payload: { scope: 'user' | 'project' }) => Promise<void>
  skillMatch: (payload: { userInput: string; sessionSkillsState: SessionSkillsState }) => Promise<SkillDefinition[]>
  skillRoute: (payload: {
    userInput: string
    sessionSkillsState: SessionSkillsState
    sessionId?: string
    sessionMetadata?: Record<string, unknown>
    recentMessages?: SkillRouteRecentMessage[]
    model?: string
  }) => Promise<SkillRouteResult>
  skillExport: (payload: { name: string; destPath: string }) => Promise<{ ok: true } | { ok: false; error: string }>
  skillInvalidateCache: () => Promise<void>

  wikiInit: (payload?: {
    overwrite?: boolean
    installSkill?: boolean
  }) => Promise<{ ok: true; rootPath: string; skillInstalled: boolean } | { ok: false; error: string }>
  wikiStatus: () => Promise<WikiStatus>
  wikiGetSchema: () => Promise<{ content: string } | null>
  wikiResolvePath: (payload: {
    relPath: string
  }) => Promise<{ absPath: string; kind: 'raw' | 'wiki' | 'schema' | 'other' } | { error: string }>
  wikiImportRaw: (payload: {
    srcRelPath: string
  }) => Promise<{ ok: true; rawRelPath: string; copied: boolean } | { ok: false; error: string }>

  projectMemoryGetState: () => Promise<ProjectMemoryState>
  projectMemoryGenerate: () => Promise<{ success: boolean; prompt?: string; content?: string; error?: string }>
  projectMemoryWrite: (payload: { content: string }) => Promise<{ success: boolean; error?: string }>
  projectMemoryReload: () => Promise<ProjectMemoryState>
  projectMemoryOnStateChanged: (
    cb: (data: ProjectMemoryState) => void
  ) => () => void

  feishuDetectCli: () => Promise<FeishuCliDetectResult>
  feishuInstallCli: () => Promise<{ success: boolean; stdout?: string; stderr?: string; timedOut?: boolean }>
  feishuInstallSkill: () => Promise<{ success: boolean; stdout?: string; stderr?: string }>
  feishuConfigInit: () => Promise<{ success: boolean; stdout?: string; stderr?: string; timedOut?: boolean; authUrl?: string }>
  feishuAuthLogin: () => Promise<{ success: boolean; authUrl?: string; stdout?: string; stderr?: string; timedOut?: boolean }>
  feishuAuthStatus: () => Promise<{ authorized: boolean; stdout?: string; stderr?: string; hint?: string }>
  feishuEventStart: () => Promise<FeishuEventStatus | undefined>
  feishuEventStop: () => Promise<FeishuEventStatus | undefined>
  feishuEventStatus: () => Promise<FeishuEventStatus | undefined>
  feishuPendingConfirms: () => Promise<FeishuPendingConfirmSummary[]>
  feishuCancelConfirm: (id: string) => Promise<boolean>
  feishuAuditTail: (limit?: number) => Promise<FeishuAuditEvent[]>
  feishuAuditQuery: (opts: { since?: number; types?: string[]; limit?: number }) => Promise<FeishuAuditQueryResult>
  feishuHealthCheck: () => Promise<FeishuHealthCheck>
  browserDetect: (force?: boolean) => Promise<BrowserDetectResult>
  browserOpenTerminal: () => Promise<{ ok: true } | { ok: false; error: string }>
  feishuCheckCliUpdate: () => Promise<{ latest?: string }>
  feishuOwnerBindStatus: () => Promise<FeishuOwnerBindSnapshot>
  feishuOwnerBeginBind: () => Promise<FeishuBindWindowResult>
  feishuOwnerRebind: () => Promise<FeishuBindWindowResult>
  feishuOwnerBindCancel: () => Promise<FeishuOwnerBindSnapshot>
  feishuOwnerClear: () => Promise<FeishuOwnerBindSnapshot>
  remoteSecurityPlan: () => Promise<RemoteSecurityMigrationPlan>
  remoteSecurityCommit: (patch: RemoteSecurityPatch) => Promise<RemoteSecurityCommitResult>
  feishuOnOwnerBound: (cb: (data: { maskedOwnerOpenId?: string; boundAt?: number }) => void) => () => void
  feishuOnConfigInitProgress: (cb: (data: { line: string }) => void) => () => void
  feishuOnConfigChanged: (cb: (data: { feishu: FeishuConfig }) => void) => () => void
  feishuOnBindTimeout: (cb: () => void) => () => void
  feishuOnInboundMessage: (cb: (data: { sessionId: string; message: unknown }) => void) => () => void
  feishuOnRemoteAgentStart: (cb: (data: {
    sessionId: string
    assistantMessageId: string
    requestId: string
  }) => void) => () => void
  feishuOnPendingConfirm: (cb: (data: { sessionId: string; pendingConfirm: boolean }) => void) => () => void
  feishuOnAgentDone: (cb: (data: {
    sessionId: string
    messageId: string
    requestId: string
    ok: boolean
    summary?: string
  }) => void) => () => void

  wechatDetectSdk: () => Promise<WeChatSdkDetectResult>
  wechatLoginStart: (opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string }>
  wechatLoginStop: () => Promise<{ ok: boolean }>
  wechatSubmitVerifyCode: (code: string) => Promise<{ ok: boolean }>
  wechatLogout: () => Promise<{ ok: boolean }>
  wechatConnectionStatus: () => Promise<WeChatConnectionStatus>
  wechatPollStart: () => Promise<WeChatConnectionStatus>
  wechatPollStop: () => Promise<WeChatConnectionStatus>
  wechatPendingConfirms: () => Promise<unknown[]>
  wechatConfirmResponse: (payload: { requestId: string; approved: boolean }) => Promise<{ ok: boolean }>
  wechatAuditTail: (limit?: number) => Promise<WeChatAuditEvent[]>
  wechatAuditQuery: (opts: { since?: number; types?: string[]; limit?: number }) => Promise<WeChatAuditQueryResult>
  wechatSend: (payload: { userId: string; text: string; imagePath?: string; filePath?: string }) => Promise<{ success: boolean; chunksSent?: number; error?: string }>
  wechatReply: (payload: { text: string; imagePath?: string; filePath?: string; sessionId?: string }) => Promise<{ success: boolean; chunksSent?: number; error?: string }>
  wechatOnQrUrl: (cb: (data: { url: string | null; expired?: boolean }) => void) => () => void
  wechatOnLoginProgress: (cb: (data: { stage: WeChatLoginProgress; code?: string; isRetry?: boolean }) => void) => () => void
  wechatOnInboundMessage: (cb: (data: { sessionId: string; message: unknown }) => void) => () => void
  wechatOnRemoteAgentStart: (cb: (data: {
    sessionId: string
    assistantMessageId: string
    requestId: string
  }) => void) => () => void
  wechatOnConfirmRequest: (cb: (data: unknown) => void) => () => void
  wechatOnPendingConfirm: (cb: (data: { count: number }) => void) => () => void
  wechatOnAgentDone: (cb: (data: {
    sessionId: string
    messageId: string
    requestId: string
    ok: boolean
    summary?: string
  }) => void) => () => void
  wechatOnPollingStats: (cb: (data: unknown) => void) => () => void

  workdirList: () => Promise<WorkDirProfile[]>
  workdirAdd: (profile: {
    name: string
    path: string
    aliases?: string[]
    isDefault?: boolean
  }) => Promise<{ success: boolean; profile?: WorkDirProfile; error?: string }>
  workdirUpdate: (
    profileId: string,
    updates: Partial<WorkDirProfile>
  ) => Promise<{ success: boolean; error?: string }>
  workdirRemove: (profileId: string) => Promise<{ success: boolean; error?: string }>
  workdirSwitch: (profileId: string) => Promise<{ success: boolean; sessions: Session[]; error?: string }>
  workdirCheckWritable: (path: string) => Promise<{ ok: boolean; error?: string }>

  onRemoteSwitchSessionRequest: (
    cb: (data: { requestId: string; sessionId: string }) => void
  ) => () => void
  remoteSwitchSessionComplete: (payload: {
    requestId: string
    desktopSwitched: boolean
    viewChanged: boolean
  }) => Promise<void>

  // 浮动通知 /test-pop 调试命令（仅主窗口渲染进程）
  testPopShow: () => Promise<void>
}

/** 浮动通知窗口数据 */
export type FloatingNotificationData = {
  totalSessions: number
  totalItems: number
  latestItem: {
    sessionId: string
    sessionName: string
    toolUseId: string
    toolName: string
    input: Record<string, unknown>
    createdAt: number
  } | null
}

/** 浮动通知窗口专用 API（仅暴露给浮动窗口的预加载脚本） */
export type FloatingNotificationWindowApi = {
  notificationReady: () => Promise<void>
  notificationGetData: () => Promise<FloatingNotificationData>
  notificationFocusSession: (payload: { sessionId: string; toolUseId?: string }) => Promise<void>
  notificationShowMain: () => Promise<void>
  notificationDismiss: () => Promise<void>
  notificationOnUpdate: (cb: (data: FloatingNotificationData) => void) => () => void
  notificationOnClose: (cb: () => void) => () => void
}
