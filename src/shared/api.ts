import type {
  AppConfig,
  AutoApproveFallback,
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
  WikiStatus
} from './domainTypes'

export type ToolConfirmResponsePayload = {
  requestId: string
  toolUseId: string
  approved: boolean
  trustCommand?: string
  trustDomain?: string
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
  WorkDirProfile
} from './feishuTypes'
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

export type ClaudeChatSendStreamPayload = {
  requestId: string
  model: string
  baseUrl?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  system?: string
  /** 未传时主进程使用内置默认；建议传渲染侧解析后的有效值 */
  maxTokens?: number
  projectMemoryEnabled?: boolean
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
  messages: ClaudeChatMessageWithBlocks[]
  tools: Array<Record<string, unknown>>
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  projectMemoryEnabled?: boolean
}

export type SpaceAssistantApi = {
  ping: () => Promise<string>

  appOpenExternal: (url: string) => Promise<{ ok: true } | { ok: false; error: string }>

  sessionList: () => Promise<Session[]>
  sessionCreate: (payload: {
    name: string
    model?: string
    temperature?: number
    maxTokens?: number
    metadata?: Record<string, unknown>
  }) => Promise<Session>
  sessionGet: (sessionId: string) => Promise<Session | undefined>
  sessionUpdate: (payload: {
    sessionId: string
    name?: string
    temperature?: number
    maxTokens?: number
    skillsState?: SessionSkillsState
    metadata?: Record<string, unknown>
  }) => Promise<Session | undefined>
  sessionBackfillAutoTitleIfNeeded: (payload: { sessionId: string }) => Promise<Session | undefined>
  sessionDelete: (sessionId: string) => Promise<void>

  usageSet: (payload: { sessionId: string; usage: SessionUsage }) => Promise<void>
  usageGet: (sessionId: string) => Promise<SessionUsage | undefined>
  usageDelete: (sessionId: string) => Promise<void>

  chatGetMessages: (payload: { sessionId: string; limit?: number; offset?: number }) => Promise<Message[]>
  chatAppendMessage: (msg: Message) => Promise<Message>
  chatPatchMessage: (payload: {
    messageId: string
    sessionId: string
    patch: Partial<Pick<Message, 'content' | 'status' | 'toolUse' | 'thinking' | 'toolCalls' | 'contentSegments' | 'skillHints'>>
  }) => Promise<void>
  chatDeleteQueuedMessage: (payload: {
    messageId: string
    sessionId: string
  }) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>

  claudeChatSendStream: (payload: ClaudeChatSendStreamPayload) => Promise<{ ok: true } | { ok: false; error: string }>
  claudeChatCreateWithTools: (
    payload: ClaudeChatCreateWithToolsPayload
  ) => Promise<
    | { ok: true; content: unknown[]; stopReason: string; usage?: unknown }
    | { ok: false; error: string }
  >
  claudeChatOnDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
  claudeChatOnThinkingDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
  claudeChatOnDone: (cb: (data: { requestId: string; usage?: unknown }) => void) => () => void
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
      activeLlmServiceId: string
      llmServiceKeys: Record<string, string>
      tools: Partial<ToolsConfig>
      skills: Partial<SkillsConfig>
      wiki: Partial<WikiConfig>
      feishu: Partial<FeishuConfig>
      workDirProfiles: WorkDirProfile[]
      activeWorkDirProfileId: string
      maxParallelChatSessions: number
      browser: Partial<import('./domainTypes').BrowserConfig>
      shell: Partial<ShellConfig>
      locale: import('./domainTypes').AppLocale
    }>
  ) => Promise<void>
  configTestConnection: (options?: {
    serviceId?: string
    apiKey?: string
    baseUrl?: string
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
  toolCancel: (payload: { requestId: string; toolUseId: string }) => Promise<void>
  toolOnUse: (cb: (data: { requestId: string; toolUse: { id: string; name: string; input: unknown } }) => void) => () => void
  toolOnConfirmRequest: (
    cb: (data: {
      requestId: string
      toolUseId: string
      toolName: string
      input: unknown
      riskLevel: ToolRiskLevel
      diff?: { oldContent: string; newContent: string; oldPath: string }
      shellSecurityHints?: ShellSecurityHints
      autoApproveFallback?: AutoApproveFallback
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
  feishuOnConfigInitProgress: (cb: (data: { line: string }) => void) => () => void
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
