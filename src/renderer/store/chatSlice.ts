import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Message } from '../../shared/domainTypes'

export type ChatStatus = 'idle' | 'sending' | 'streaming' | 'completed' | 'error'

export type RunningSessionMeta = {
  requestId: string
  status: 'streaming' | 'error'
  updatedAt: number
}

export type LastUsage = {
  input_tokens: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
} | null

interface ChatState {
  messages: Message[]
  currentSessionId: string | null
  chatStatus: ChatStatus
  error: string | null
  /** 按会话记录的运行中请求（支持多会话并行） */
  runningSessions: Record<string, RunningSessionMeta>
  /** 侧栏待办跳转后高亮的工具确认项 */
  confirmFocusToolUseId: string | null
  lastUsage: LastUsage
  projectMemoryEnabled: boolean
}

const initialState: ChatState = {
  messages: [],
  currentSessionId: null,
  chatStatus: 'idle',
  error: null,
  runningSessions: {},
  confirmFocusToolUseId: null,
  lastUsage: null,
  projectMemoryEnabled: true
}

export const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setSession(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload
      state.confirmFocusToolUseId = null
      state.lastUsage = null
    },
    setConfirmFocusToolUseId(state, action: PayloadAction<string | null>) {
      state.confirmFocusToolUseId = action.payload
    },
    setLastUsage(state, action: PayloadAction<LastUsage>) {
      state.lastUsage = action.payload
    },
    setMessages(state, action: PayloadAction<Message[]>) {
      state.messages = action.payload
    },
    addMessage(state, action: PayloadAction<Message>) {
      state.messages.push(action.payload)
    },
    patchMessage(state, action: PayloadAction<{ id: string; patch: Partial<Message> }>) {
      const m = state.messages.find((x) => x.id === action.payload.id)
      if (m) Object.assign(m, action.payload.patch)
    },
    setChatStatus(
      state,
      action: PayloadAction<{
        status: ChatStatus
        error?: string | null
        requestId?: string | null
        sessionId?: string | null
      }>
    ) {
      const { status, error, requestId, sessionId } = action.payload
      state.chatStatus = status
      state.error = error ?? null

      if (status === 'streaming' && sessionId && requestId) {
        state.runningSessions[sessionId] = {
          requestId,
          status: 'streaming',
          updatedAt: Date.now()
        }
      }

      const terminal = status === 'completed' || status === 'error' || status === 'idle'
      if (terminal && sessionId) {
        delete state.runningSessions[sessionId]
      } else if (terminal && !sessionId && requestId === null) {
        state.runningSessions = {}
      }
    },
    removeRunningSession(state, action: PayloadAction<string>) {
      delete state.runningSessions[action.payload]
    },
    resetChatUi(state) {
      state.messages = []
      state.chatStatus = 'idle'
      state.error = null
      state.runningSessions = {}
      state.confirmFocusToolUseId = null
      state.lastUsage = null
      state.projectMemoryEnabled = true
    },
    setProjectMemoryEnabled(state, action: PayloadAction<boolean>) {
      state.projectMemoryEnabled = action.payload
    }
  }
})

export const {
  setSession,
  setMessages,
  addMessage,
  patchMessage,
  setChatStatus,
  setConfirmFocusToolUseId,
  removeRunningSession,
  resetChatUi,
  setLastUsage,
  setProjectMemoryEnabled
} = chatSlice.actions
export default chatSlice.reducer
