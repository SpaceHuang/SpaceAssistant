import type { Message } from '../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../../shared/domainTypes'
import type { PlanStepCompletedEvent, PlanStepStartedEvent } from '../../shared/api'
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
import { addMessage, setChatStatus } from '../store/chatSlice'
import {
  flushStreamPersist,
  flushUiPatch,
  getLiveMessages,
  initLiveSessionFromStore,
  registerSessionRun,
  routePatchMessage,
  routeStreamPatchMessage
} from './chatRunnerService'
import { unregisterRunRequest } from './runRequestIndex'
import { createToolChatController } from './chatToolSessionService'

type StepStreamBridge = {
  sessionId: string
  assistantMessageId: string
  requestId: string
  stream: { contentState: ContentState; thinkingState: ThinkingState }
  cleanup: () => void
}

type ActivePlanAutoSession = {
  loopRequestId: string
  onScroll?: () => void
  unsubStepStarted: () => void
  unsubStepCompleted: () => void
}

const stepBridges = new Map<string, StepStreamBridge>()
const activeSessions = new Map<string, ActivePlanAutoSession>()

function findAssistantRow(sessionId: string, assistantMessageId: string): Message | undefined {
  return (
    getLiveMessages(sessionId)?.find((m) => m.id === assistantMessageId) ??
    store.getState().chat.messages.find((m) => m.id === assistantMessageId)
  )
}

function attachStepStreamBridge(
  sessionId: string,
  assistantMessageId: string,
  requestId: string,
  assistantTimestamp: number,
  initialContent: string
): void {
  stepBridges.get(requestId)?.cleanup()

  let contentState = createContentState(assistantTimestamp)
  const thinkingState = createThinkingState(assistantTimestamp)
  if (initialContent) {
    contentState = appendContentDelta(contentState, initialContent)
    routeStreamPatchMessage(
      sessionId,
      assistantMessageId,
      buildAssistantStreamPatch(thinkingState, contentState)
    )
  }

  const stream = { contentState, thinkingState }

  const controller = createToolChatController({
    dispatch: store.dispatch,
    assistantMessageId,
    getRequestId: () => requestId,
    applyAssistantPatch: (patch) => routePatchMessage(sessionId, assistantMessageId, patch),
    onRecordsChange: () => activeSessions.get(sessionId)?.onScroll?.()
  })
  controller.subscribe()

  const unsubs: Array<() => void> = []
  const cleanup = () => {
    controller.unsubscribe()
    for (const u of unsubs) u()
    unsubs.length = 0
    stepBridges.delete(requestId)
    unregisterRunRequest(requestId)
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
      activeSessions.get(sessionId)?.onScroll?.()
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
      activeSessions.get(sessionId)?.onScroll?.()
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
    }),
    window.api.claudeChatOnError((d) => {
      if (d.requestId !== requestId) return
      void finalizeStepStreamBridge({ requestId, ok: false, summary: d.message })
    })
  )

  stepBridges.set(requestId, { sessionId, assistantMessageId, requestId, stream, cleanup })
  registerSessionRun(sessionId, requestId)
  store.dispatch(setChatStatus({ status: 'streaming', requestId, sessionId }))
}

async function finalizeStepStreamBridge(args: {
  requestId: string
  ok?: boolean
  summary?: string
}): Promise<void> {
  const bridge = stepBridges.get(args.requestId)
  if (!bridge) return

  const { sessionId, assistantMessageId, requestId, stream } = bridge
  const ctx = activeSessions.get(sessionId)

  if (args.summary && !stream.contentState.content.trim()) {
    stream.contentState = { ...stream.contentState, content: args.summary }
  }

  flushStreamPersist(sessionId, assistantMessageId)
  flushUiPatch(sessionId, assistantMessageId)

  const assistantRow = findAssistantRow(sessionId, assistantMessageId)
  const thinking = finalizeThinking(stream.thinkingState)
  const contentSegments = finalizeContentSegments(stream.contentState)
  const textOut = stream.contentState.content.trim() || args.summary || ''
  const ok = args.ok !== false
  const finalPatch = {
    content: textOut,
    contentSegments,
    status: ok ? ('completed' as const) : ('failed' as const),
    thinking,
    toolCalls: assistantRow?.toolCalls
  }

  routePatchMessage(sessionId, assistantMessageId, finalPatch)
  await window.api.chatPatchMessage({
    messageId: assistantMessageId,
    sessionId,
    patch: finalPatch
  })

  bridge.cleanup()

  if (ctx) {
    store.dispatch(setChatStatus({ status: 'streaming', requestId: ctx.loopRequestId, sessionId }))
  }
}

async function handlePlanStepStarted(d: PlanStepStartedEvent): Promise<void> {
  const ctx = activeSessions.get(d.sessionId)
  if (!ctx) return

  const assistantId = crypto.randomUUID()
  const timestamp = Date.now()
  const intro = `步骤 ${d.stepIndex + 1}/${d.stepsTotal} 执行中…`
  const assistantMsg: Message = {
    id: assistantId,
    sessionId: d.sessionId,
    role: 'assistant',
    content: intro,
    timestamp,
    status: 'streaming',
    schemaVersion: CURRENT_SCHEMA_VERSION
  }

  if (store.getState().chat.currentSessionId === d.sessionId) {
    store.dispatch(addMessage(assistantMsg))
    initLiveSessionFromStore(d.sessionId)
  }
  await window.api.chatAppendMessage(assistantMsg)
  attachStepStreamBridge(d.sessionId, assistantId, d.requestId, timestamp, intro)
  ctx.onScroll?.()
}

async function handlePlanStepCompleted(d: PlanStepCompletedEvent): Promise<void> {
  const ctx = activeSessions.get(d.sessionId)
  if (!ctx) return
  await finalizeStepStreamBridge({ requestId: d.requestId, ok: true, summary: d.summary })
  ctx.onScroll?.()
}

export function isPlanAutoExecutionStreamActive(sessionId: string): boolean {
  return activeSessions.has(sessionId)
}

export function beginPlanAutoExecutionStream(args: {
  sessionId: string
  loopRequestId: string
  onScroll?: () => void
}): void {
  endPlanAutoExecutionStream(args.sessionId)

  activeSessions.set(args.sessionId, {
    loopRequestId: args.loopRequestId,
    onScroll: args.onScroll,
    unsubStepStarted: window.api.planOnStepStarted((d) => {
      void handlePlanStepStarted(d)
    }),
    unsubStepCompleted: window.api.planOnStepCompleted((d) => {
      void handlePlanStepCompleted(d)
    })
  })
}

export function endPlanAutoExecutionStream(sessionId: string): void {
  const ctx = activeSessions.get(sessionId)
  if (!ctx) return

  ctx.unsubStepStarted()
  ctx.unsubStepCompleted()
  activeSessions.delete(sessionId)

  for (const [requestId, bridge] of [...stepBridges.entries()]) {
    if (bridge.sessionId === sessionId) {
      void finalizeStepStreamBridge({ requestId, ok: false, summary: '计划执行已结束' })
    }
  }
}

/** @internal 测试用 */
export function clearPlanAutoExecutionStreamState(): void {
  for (const sessionId of [...activeSessions.keys()]) {
    endPlanAutoExecutionStream(sessionId)
  }
  stepBridges.clear()
  activeSessions.clear()
}
