import type {
  AppConfig,
  FileInfo,
  Message,
  SearchResult,
  Session,
  SessionSkillsState,
  SkillDefinition,
  SkillsConfig,
  ToolCallResultPersisted,
  ToolRiskLevel,
  ToolsConfig
} from './domainTypes'

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
}

export type SpaceAssistantApi = {
  ping: () => Promise<string>

  sessionList: () => Promise<Session[]>
  sessionCreate: (payload: { name: string; model?: string; temperature?: number; maxTokens?: number }) => Promise<Session>
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

  chatGetMessages: (payload: { sessionId: string; limit?: number; offset?: number }) => Promise<Message[]>
  chatAppendMessage: (msg: Message) => Promise<Message>
  chatPatchMessage: (payload: {
    messageId: string
    sessionId: string
    patch: Partial<Pick<Message, 'content' | 'status' | 'toolUse' | 'thinking' | 'toolCalls' | 'contentSegments'>>
  }) => Promise<void>

  claudeChatSendStream: (payload: ClaudeChatSendStreamPayload) => Promise<{ ok: true } | { ok: false; error: string }>
  claudeChatCreateWithTools: (
    payload: ClaudeChatCreateWithToolsPayload
  ) => Promise<
    | { ok: true; content: unknown[]; stopReason: string; usage?: unknown }
    | { ok: false; error: string }
  >
  claudeChatOnDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
  claudeChatOnThinkingDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
  claudeChatOnDone: (cb: (data: { requestId: string }) => void) => () => void
  claudeChatOnError: (cb: (data: { requestId: string; message: string }) => void) => () => void
  claudeChatCancel: (payload: { requestId: string }) => Promise<void>

  configGet: () => Promise<AppConfig>
  configSet: (
    payload: Partial<{
      baseUrl: string
      model: string
      temperature: number
      maxTokens: number
      defaultModel: string
      models: import('./domainTypes').ModelEntry[]
      thinkingEnabled: boolean
      workDir: string
      apiKey: string
      tools: Partial<ToolsConfig>
      skills: Partial<SkillsConfig>
    }>
  ) => Promise<void>
  configTestConnection: () => Promise<{ success: boolean; error?: string }>

  dialogSelectDirectory: () => Promise<{ path: string } | { canceled: true } | { error: string }>
  configCheckWorkdirWritable: (dir: string) => Promise<{ writable: boolean; error?: string }>

  fileListDirectory: (relPath: string) => Promise<FileInfo[]>
  fileReadFile: (relPath: string) => Promise<FileReadResult>
  fileGetMetadata: (relPath: string) => Promise<FileMetadata>
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

  searchExecute: (query: string) => Promise<SearchResult[]>
  searchGetHistory: () => Promise<string[]>

  onOpenSettings: (cb: () => void) => () => void
  onOpenAbout: (cb: () => void) => () => void

  sessionOnTitleGenerated: (cb: (data: { session: Session }) => void) => () => void

  toolConfirmResponse: (payload: { requestId: string; toolUseId: string; approved: boolean }) => Promise<void>
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
    }) => void
  ) => () => void
  toolOnProgress: (cb: (data: { requestId: string; toolUseId: string; status: string; message?: string }) => void) => () => void
  toolOnResult: (
    cb: (data: { requestId: string; toolUseId: string; result: ToolCallResultPersisted }) => void
  ) => () => void
  toolTestInterpreter: (payload: { path: string }) => Promise<{ ok: true; version: string } | { ok: false; error: string }>

  skillList: () => Promise<SkillDefinition[]>
  skillGet: (payload: { name: string }) => Promise<SkillDefinition | null>
  skillInstall: (payload: { sourcePath: string; overwrite?: boolean }) => Promise<{ ok: true; skill: SkillDefinition } | { ok: false; error: string }>
  skillDelete: (payload: { name: string }) => Promise<void>
  skillToggleDisable: (payload: { name: string; disabled: boolean }) => Promise<void>
  skillOpenDirectory: (payload: { scope: 'user' | 'project' }) => Promise<void>
  skillMatch: (payload: { userInput: string; sessionSkillsState: SessionSkillsState }) => Promise<SkillDefinition[]>
  skillExport: (payload: { name: string; destPath: string }) => Promise<{ ok: true } | { ok: false; error: string }>
  skillInvalidateCache: () => Promise<void>
}
