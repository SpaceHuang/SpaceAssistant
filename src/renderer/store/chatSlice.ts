import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Message } from '../../shared/domainTypes'

export type ChatStatus = 'idle' | 'sending' | 'streaming' | 'completed' | 'error'

interface ChatState {
  messages: Message[]
  currentSessionId: string | null
  chatStatus: ChatStatus
  error: string | null
  streamingRequestId: string | null
  /** 当前正在执行指令（流式/工具循环）的会话 ID */
  runningSessionId: string | null
}

const initialState: ChatState = {
  messages: [],
  currentSessionId: null,
  chatStatus: 'idle',
  error: null,
  streamingRequestId: null,
  runningSessionId: null
}

export const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setSession(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload
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
      state.chatStatus = action.payload.status
      state.error = action.payload.error ?? null
      if (action.payload.requestId !== undefined) state.streamingRequestId = action.payload.requestId
      if (action.payload.sessionId !== undefined) {
        state.runningSessionId = action.payload.sessionId
      } else if (
        action.payload.status === 'idle' ||
        action.payload.status === 'completed' ||
        action.payload.status === 'error'
      ) {
        state.runningSessionId = null
      }
    },
    resetChatUi(state) {
      state.messages = []
      state.chatStatus = 'idle'
      state.error = null
      state.streamingRequestId = null
      state.runningSessionId = null
    }
  }
})

export const { setSession, setMessages, addMessage, patchMessage, setChatStatus, resetChatUi } = chatSlice.actions
export default chatSlice.reducer
