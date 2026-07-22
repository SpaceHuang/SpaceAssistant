import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { Message } from '../../shared/domainTypes'
import type { DisplayMessageEntry, DisplayOrder } from '../../shared/displayOrder'
import type { SessionUsage } from '../../shared/sessionUsage'
import {
  ackDisplayEntryPersisted,
  appendOptimisticDisplayEntry,
  mergeDisplayEntries,
  patchDisplayEntryMessage
} from '../services/displayMessageMerge'

export type ChatStatus = 'idle' | 'sending' | 'streaming' | 'completed' | 'error'

export type RunningSessionMeta = {
  requestId: string
  status: 'streaming' | 'error'
  updatedAt: number
}

export type LastUsage = SessionUsage | null

interface ChatState {
  /** @deprecated 由 displayEntries 派生；过渡期双写 */
  messages: Message[]
  displayEntries: DisplayMessageEntry[]
  oldestSequence: number | null
  hasMoreBefore: boolean
  loadingBefore: boolean
  displayGeneration: number
  nextOptimisticOrdinal: number
  currentSessionId: string | null
  chatStatus: ChatStatus
  error: string | null
  /** 按会话记录的运行中请求（支持多会话并行） */
  runningSessions: Record<string, RunningSessionMeta>
  /** 侧栏待办跳转后高亮的工具确认项 */
  confirmFocusToolUseId: string | null
  /** 搜索结果跳转后滚动定位的消息 ID */
  scrollToMessageId: string | null
  lastUsage: LastUsage
  projectMemoryEnabled: boolean
}

function syncMessagesFromEntries(state: ChatState): void {
  state.messages = state.displayEntries.map((e) => e.message)
}

const initialState: ChatState = {
  messages: [],
  displayEntries: [],
  oldestSequence: null,
  hasMoreBefore: false,
  loadingBefore: false,
  displayGeneration: 0,
  nextOptimisticOrdinal: 0,
  currentSessionId: null,
  chatStatus: 'idle',
  error: null,
  runningSessions: {},
  confirmFocusToolUseId: null,
  scrollToMessageId: null,
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
      state.scrollToMessageId = null
    },
    setConfirmFocusToolUseId(state, action: PayloadAction<string | null>) {
      state.confirmFocusToolUseId = action.payload
    },
    setScrollToMessageId(state, action: PayloadAction<string | null>) {
      state.scrollToMessageId = action.payload
    },
    setLastUsage(state, action: PayloadAction<{ sessionId: string; usage: SessionUsage }>) {
      state.lastUsage = action.payload.usage
    },
    restoreLastUsage(state, action: PayloadAction<LastUsage>) {
      state.lastUsage = action.payload
    },
    setMessages(state, action: PayloadAction<Message[]>) {
      state.messages = action.payload
      // 兼容旧路径：无 sequence 时用乐观序
      state.displayEntries = action.payload.map((message, i) => ({
        message,
        order: { kind: 'optimistic' as const, ordinal: i }
      }))
      state.nextOptimisticOrdinal = action.payload.length
      state.oldestSequence = null
      state.hasMoreBefore = false
    },
    setDisplayPage(
      state,
      action: PayloadAction<{
        entries: Array<{ message: Message; sequence: number }>
        oldestSequence: number | null
        hasMoreBefore: boolean
        generation: number
      }>
    ) {
      const { entries, oldestSequence, hasMoreBefore, generation } = action.payload
      state.displayGeneration = generation
      state.displayEntries = mergeDisplayEntries([], entries)
      state.oldestSequence = oldestSequence
      state.hasMoreBefore = hasMoreBefore
      state.loadingBefore = false
      state.nextOptimisticOrdinal = 0
      syncMessagesFromEntries(state)
    },
    prependDisplayPage(
      state,
      action: PayloadAction<{
        entries: Array<{ message: Message; sequence: number }>
        oldestSequence: number | null
        hasMoreBefore: boolean
        generation: number
      }>
    ) {
      if (action.payload.generation !== state.displayGeneration) return
      state.displayEntries = mergeDisplayEntries(state.displayEntries, action.payload.entries)
      state.oldestSequence = action.payload.oldestSequence
      state.hasMoreBefore = action.payload.hasMoreBefore
      state.loadingBefore = false
      syncMessagesFromEntries(state)
    },
    setLoadingBefore(state, action: PayloadAction<boolean>) {
      state.loadingBefore = action.payload
    },
    addMessage(state, action: PayloadAction<Message>) {
      const ordinal = state.nextOptimisticOrdinal++
      state.displayEntries = appendOptimisticDisplayEntry(state.displayEntries, action.payload, ordinal)
      syncMessagesFromEntries(state)
    },
    ackDisplayMessagePersisted(
      state,
      action: PayloadAction<{ messageId: string; sequence: number }>
    ) {
      state.displayEntries = ackDisplayEntryPersisted(
        state.displayEntries,
        action.payload.messageId,
        action.payload.sequence
      )
      syncMessagesFromEntries(state)
    },
    patchDisplayMessage(
      state,
      action: PayloadAction<{ id: string; patch: Partial<Message>; order?: DisplayOrder }>
    ) {
      let next = patchDisplayEntryMessage(state.displayEntries, action.payload.id, action.payload.patch)
      if (action.payload.order) {
        next = next.map((e) =>
          e.message.id === action.payload.id ? { ...e, order: action.payload.order! } : e
        )
      }
      state.displayEntries = next
      syncMessagesFromEntries(state)
    },
    removeDisplayMessage(state, action: PayloadAction<string>) {
      state.displayEntries = state.displayEntries.filter((e) => e.message.id !== action.payload)
      syncMessagesFromEntries(state)
    },
    patchMessage(state, action: PayloadAction<{ id: string; patch: Partial<Message> }>) {
      state.displayEntries = patchDisplayEntryMessage(
        state.displayEntries,
        action.payload.id,
        action.payload.patch
      )
      syncMessagesFromEntries(state)
    },
    removeMessage(state, action: PayloadAction<string>) {
      state.displayEntries = state.displayEntries.filter((m) => m.message.id !== action.payload)
      syncMessagesFromEntries(state)
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
      state.displayEntries = []
      state.oldestSequence = null
      state.hasMoreBefore = false
      state.loadingBefore = false
      state.displayGeneration = 0
      state.nextOptimisticOrdinal = 0
      state.chatStatus = 'idle'
      state.error = null
      state.runningSessions = {}
      state.confirmFocusToolUseId = null
      state.scrollToMessageId = null
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
  setDisplayPage,
  prependDisplayPage,
  setLoadingBefore,
  addMessage,
  ackDisplayMessagePersisted,
  patchDisplayMessage,
  removeDisplayMessage,
  patchMessage,
  removeMessage,
  setChatStatus,
  setConfirmFocusToolUseId,
  setScrollToMessageId,
  removeRunningSession,
  resetChatUi,
  setLastUsage,
  restoreLastUsage,
  setProjectMemoryEnabled
} = chatSlice.actions
export default chatSlice.reducer
