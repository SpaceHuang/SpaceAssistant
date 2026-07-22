import type { Message } from '../../shared/domainTypes'
import { buildAssistantStreamPatch } from '../../shared/assistantStreamPatch'
import {
  appendContentDelta,
  closeOpenContentSegment,
  createContentState,
  finalizeContentSegments,
  hasOpenContentSegment,
  type ContentState
} from '../../shared/contentSegments'
import {
  appendThinkingDelta,
  closeOpenThinkingSegment,
  createThinkingState,
  finalizeThinking,
  hasOpenThinkingSegment,
  type ThinkingState
} from '../../shared/thinkingSegments'
import { store } from '../store'
import { setChatStatus, setDisplayPage } from '../store/chatSlice'
import { upsertSession } from '../store/sessionSlice'
import {
  clearLiveSession,
  finishSessionRun,
  flushStreamPersist,
  flushUiPatch,
  getLiveMessages,
  registerSessionRun,
  resetLiveSessionMessages,
  routePatchMessage,
  routeStreamPatchMessage
} from './chatRunnerService'
import { createToolChatController } from './chatToolSessionService'

type StreamBridge = {
  sessionId: string
  assistantMessageId: string
  requestId: string
  stream: { contentState: ContentState; thinkingState: ThinkingState }
  cleanup: () => void
}

const bridges = new Map<string, StreamBridge>()

function findAssistantRow(sessionId: string, assistantMessageId: string): Message | undefined {
  return (
    getLiveMessages(sessionId)?.find((m) => m.id === assistantMessageId) ??
    store.getState().chat.messages.find((m) => m.id === assistantMessageId)
  )
}

async function syncSessionMessages(sessionId: string): Promise<Message[]> {
  const page = await window.api.chatGetMessagePage({ sessionId, limit: 60 })
  const rows = page.entries.map((e) => e.message)
  resetLiveSessionMessages(sessionId, rows)
  if (store.getState().chat.currentSessionId === sessionId) {
    store.dispatch(
      setDisplayPage({
        entries: page.entries,
        oldestSequence: page.oldestSequence,
        hasMoreBefore: page.hasMoreBefore,
        generation: store.getState().chat.displayGeneration + 1
      })
    )
  }
  return rows
}

function attachStreamBridge(
  sessionId: string,
  assistantMessageId: string,
  requestId: string,
  assistantTimestamp: number
): void {
  bridges.get(requestId)?.cleanup()

  const stream = {
    contentState: createContentState(assistantTimestamp),
    thinkingState: createThinkingState(assistantTimestamp)
  }

  const controller = createToolChatController({
    dispatch: store.dispatch,
    assistantMessageId,
    getRequestId: () => requestId,
    applyAssistantPatch: (patch) => routePatchMessage(sessionId, assistantMessageId, patch)
  })
  controller.subscribe()

  const unsubs: Array<() => void> = []
  const cleanup = () => {
    controller.unsubscribe()
    for (const u of unsubs) u()
    unsubs.length = 0
    bridges.delete(requestId)
  }

  unsubs.push(
    window.api.claudeChatOnDelta((d) => {
      if (d.requestId !== requestId) return
      if (hasOpenThinkingSegment(stream.thinkingState)) {
        stream.thinkingState = closeOpenThinkingSegment(stream.thinkingState)
      }
      stream.contentState = appendContentDelta(stream.contentState, d.text)
      routeStreamPatchMessage(
        sessionId,
        assistantMessageId,
        buildAssistantStreamPatch(stream.thinkingState, stream.contentState)
      )
    }),
    window.api.claudeChatOnThinkingDelta((d) => {
      if (d.requestId !== requestId) return
      if (hasOpenContentSegment(stream.contentState)) {
        stream.contentState = closeOpenContentSegment(stream.contentState)
      }
      stream.thinkingState = appendThinkingDelta(stream.thinkingState, d.text)
      routeStreamPatchMessage(
        sessionId,
        assistantMessageId,
        buildAssistantStreamPatch(stream.thinkingState, stream.contentState)
      )
    }),
    window.api.toolOnUse((d) => {
      if (d.requestId !== requestId) return
      let changed = false
      if (hasOpenThinkingSegment(stream.thinkingState)) {
        stream.thinkingState = closeOpenThinkingSegment(stream.thinkingState)
        changed = true
      }
      if (hasOpenContentSegment(stream.contentState)) {
        stream.contentState = closeOpenContentSegment(stream.contentState)
        changed = true
      }
      if (!changed) return
      routeStreamPatchMessage(
        sessionId,
        assistantMessageId,
        buildAssistantStreamPatch(stream.thinkingState, stream.contentState)
      )
    })
  )

  bridges.set(requestId, { sessionId, assistantMessageId, requestId, stream, cleanup })
  registerSessionRun(sessionId, requestId)
  store.dispatch(setChatStatus({ status: 'streaming', requestId, sessionId }))
}

async function finalizeStreamBridge(payload: {
  sessionId: string
  messageId: string
  requestId: string
  ok: boolean
  summary?: string
}): Promise<void> {
  const bridge = bridges.get(payload.requestId)
  const { sessionId, messageId: assistantMessageId, requestId } = payload
  const stream = bridge?.stream ?? {
    contentState: createContentState(Date.now()),
    thinkingState: createThinkingState(Date.now())
  }

  if (payload.summary && !stream.contentState.content) {
    stream.contentState = { ...stream.contentState, content: payload.summary }
  }

  flushStreamPersist(sessionId, assistantMessageId)
  flushUiPatch(sessionId, assistantMessageId)

  const assistantRow = findAssistantRow(sessionId, assistantMessageId)
  const thinking = finalizeThinking(stream.thinkingState)
  const contentSegments = finalizeContentSegments(stream.contentState)
  const textOut = stream.contentState.content || payload.summary || ''
  const status = payload.ok ? ('completed' as const) : ('failed' as const)
  const finalPatch = {
    content: textOut,
    contentSegments,
    status,
    thinking,
    toolCalls: assistantRow?.toolCalls
  }

  routePatchMessage(sessionId, assistantMessageId, finalPatch)
  await window.api.chatPatchMessage({
    messageId: assistantMessageId,
    sessionId,
    patch: finalPatch
  })

  store.dispatch(
    setChatStatus({
      status: payload.ok ? 'completed' : 'error',
      error: payload.ok ? null : textOut,
      requestId: null,
      sessionId
    })
  )
  finishSessionRun(sessionId, requestId, assistantMessageId)
  bridge?.cleanup()
  clearLiveSession(sessionId)

  void window.api.sessionGet(sessionId).then((s) => {
    if (s) store.dispatch(upsertSession(s))
  })
}

/** 订阅微信远程 Agent 流式事件，复用桌面端工具卡片与流式 UI。 */
export function initWeChatRemoteStreamBridge(): () => void {
  const offStart = window.api.wechatOnRemoteAgentStart((d) => {
    void (async () => {
      const rows = await syncSessionMessages(d.sessionId)
      const assistant = rows.find((m) => m.id === d.assistantMessageId)
      attachStreamBridge(d.sessionId, d.assistantMessageId, d.requestId, assistant?.timestamp ?? Date.now())
    })()
  })

  const offDone = window.api.wechatOnAgentDone((d) => {
    void finalizeStreamBridge(d)
  })

  return () => {
    offStart()
    offDone()
    for (const bridge of bridges.values()) bridge.cleanup()
  }
}
