import type { AppConfig, FileInfo, Message, SearchResult, Session } from './domainTypes'

export type ClaudeChatSendStreamPayload = {
  requestId: string
  model: string
  baseUrl?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
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
  }) => Promise<Session | undefined>
  sessionDelete: (sessionId: string) => Promise<void>

  chatGetMessages: (payload: { sessionId: string; limit?: number; offset?: number }) => Promise<Message[]>
  chatAppendMessage: (msg: Message) => Promise<Message>
  chatPatchMessage: (payload: {
    messageId: string
    sessionId: string
    patch: Partial<Pick<Message, 'content' | 'status' | 'toolUse' | 'thinking'>>
  }) => Promise<void>

  claudeChatSendStream: (payload: ClaudeChatSendStreamPayload) => Promise<{ ok: true } | { ok: false; error: string }>
  claudeChatOnDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
  claudeChatOnThinkingDelta: (cb: (data: { requestId: string; text: string }) => void) => () => void
  claudeChatOnDone: (cb: (data: { requestId: string }) => void) => () => void
  claudeChatOnError: (cb: (data: { requestId: string; message: string }) => void) => () => void

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
    }>
  ) => Promise<void>
  configTestConnection: () => Promise<{ success: boolean; error?: string }>

  dialogSelectDirectory: () => Promise<{ path: string } | { canceled: true } | { error: string }>
  configCheckWorkdirWritable: (dir: string) => Promise<{ writable: boolean; error?: string }>

  fileListDirectory: (relPath: string) => Promise<FileInfo[]>
  fileReadFile: (relPath: string) => Promise<{ content: string; encoding: string }>

  searchExecute: (query: string) => Promise<SearchResult[]>
  searchGetHistory: () => Promise<string[]>

  onOpenSettings: (cb: () => void) => () => void
  onOpenAbout: (cb: () => void) => () => void
}
