import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Typography } from 'antd'

const { Text } = Typography
import { useTypedSelector, useAppDispatch } from '../../hooks'
import { addMessage, setChatStatus, setConfirmFocusToolUseId, setLastUsage, setMessages } from '../../store/chatSlice'
import type { LastUsage } from '../../store/chatSlice'
import {
  clearLiveSession,
  countRunningSessions,
  finishSessionRun,
  flushStreamPersist,
  flushUiPatch,
  getLiveMessages,
  initLiveSessionFromStore,
  getMaxParallelChatSessions,
  mergeDbAndLive,
  abortSessionRun,
  registerSessionRun,
  routePatchMessage,
  routeStreamPatchMessage,
  isSessionRunning
} from '../../services/chatRunnerService'
import { pendingConfirmStore } from '../../services/pendingConfirmStore'
import { upsertSession } from '../../store/sessionSlice'
import { store } from '../../store'
import { runClaudeChatStream } from '../../services/chatStreamService'
import {
  buildToolChatPayload,
  createToolChatController,
  extractAssistantTextFromApiContent
} from '../../services/chatToolSessionService'
import { parseSkillCommand } from '../../services/skillCommandService'
import { parseWikiCommand } from '../../services/wikiCommandService'
import { appendWikiSchemaToSystemPrompt } from '../../services/wikiPrompt'
import { appendArchivedQuery, patchSessionWikiState } from '../../services/wikiSessionState'
import { requestFilePaneSelect, isUnderWikiRoot } from '../../services/filePaneNavigation'
import { appendSkillActivationLog } from '../../services/skillActivationLog'
import { filterBuiltinToolsForRenderer } from '../../../shared/toolsConfigFilter'
import { buildSystemPromptFromSkills, formatSkillHint, truncateSystemPrompt } from '../../../shared/skillPrompt'
import type { Message } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE, DEFAULT_WIKI_CONFIG, normalizeSessionSkillsState } from '../../../shared/domainTypes'
import { resolveEffectiveOutputMaxTokens } from '../../../shared/llm/outputMaxTokens'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import { ChatBubble } from './ChatBubble'
import { MessageInput, type MessageInputHandle } from './MessageInput'
import type { ComposerFocusRequest } from '../Plan/PlanPanelActionsContext'
import { derivePlanExecutionUiState } from '../Plan/planExecutionUiState'
import { planPanelActionsStore } from '../../services/planPanelActionsStore'
import type { ChatMode } from '../../../shared/planTypes'
import { DEFAULT_CHAT_MODE, getPlanMeta, isPlanDrafting } from '../../../shared/planTypes'
import { SkillHintBubble } from './SkillHintBubble'
import { CHAT_CANCELLED_MESSAGE, isChatCancelledError } from '../../../shared/chatCancel'
import { buildAssistantStreamPatch } from '../../../shared/assistantStreamPatch'
import {
  appendContentDelta,
  closeOpenContentSegment,
  createContentState,
  finalizeContentSegments,
  hasOpenContentSegment,
  type ContentState
} from '../../../shared/contentSegments'
import {
  appendThinkingDelta,
  closeOpenThinkingSegment,
  createThinkingState,
  finalizeThinking,
  hasOpenThinkingSegment,
  type ThinkingState
} from '../../../shared/thinkingSegments'
import { throttle } from '../../utils/throttle'

const PLAN_REJECT_GUIDE = '请说明拒绝原因或修改方向：'
const PLAN_REVISE_GUIDE = '请描述你对计划的修改意见：'

function buildClaudePayload(history: Message[]) {
  return history
    .filter((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') return false
      if (m.role === 'assistant' && m.status === 'streaming') return false
      return true
    })
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : ''
    }))
}

export function ChatView() {
  const { message } = App.useApp()
  const { openFile } = useDetailPanel()
  const dispatch = useAppDispatch()
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const messages = useTypedSelector((s) => s.chat.messages)
  const runningSessions = useTypedSelector((s) => s.chat.runningSessions)
  const confirmFocusToolUseId = useTypedSelector((s) => s.chat.confirmFocusToolUseId)
  const cfg = useTypedSelector((s) => s.config.config)
  const currentSession = useTypedSelector((s) => s.session.list.find((x) => x.id === s.chat.currentSessionId))
  const modelEntry = cfg?.models?.find((m) => m.name === cfg.model)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<MessageInputHandle>(null)
  const composerPendingAction = useRef<'reject' | 'revise' | null>(null)
  const abortRequestedRef = useRef(false)
  const [skillHints, setSkillHints] = useState<string[]>([])
  const [chatMode, setChatMode] = useState<ChatMode>(DEFAULT_CHAT_MODE)
  const [planActionLoading, setPlanActionLoading] = useState(false)
  const [planRevisionFeedback, setPlanRevisionFeedback] = useState<string | undefined>(undefined)

  const reloadPlanState = useCallback(async () => {
    if (!sessionId) return null
    const data = await window.api.planRead({ sessionId })
    const s = await window.api.sessionGet(sessionId)
    if (s) dispatch(upsertSession(s))
    return data
  }, [sessionId, dispatch])

  useEffect(() => {
    setChatMode(cfg?.defaultChatMode ?? DEFAULT_CHAT_MODE)
  }, [cfg?.defaultChatMode])

  useEffect(() => {
    void reloadPlanState()
  }, [reloadPlanState])

  useEffect(() => {
    if (!sessionId) return
    const unsub = window.api.planOnStateChanged((d) => {
      if (d.sessionId === sessionId) void reloadPlanState()
    })
    return unsub
  }, [sessionId, reloadPlanState])

  useEffect(() => {
    if (!sessionId) return
    const unsub = window.api.planOnApprovalReady((d) => {
      if (d.sessionId !== sessionId) return
      void reloadPlanState()
      window.dispatchEvent(new CustomEvent('plan-focus'))
    })
    return unsub
  }, [sessionId, reloadPlanState])

  const streamingAssistantId = useMemo(
    () => messages.find((m) => m.role === 'assistant' && m.status === 'streaming')?.id,
    [messages]
  )

  useEffect(() => {
    if (!sessionId) {
      dispatch(setMessages([]))
      return
    }
    let cancelled = false
    void window.api.chatGetMessages({ sessionId }).then((rows) => {
      if (cancelled) return
      const live = getLiveMessages(sessionId)
      dispatch(setMessages(mergeDbAndLive(rows, live)))
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, dispatch])

  const reloadSessionMessagesFromDb = useCallback(
    async (targetSessionId: string) => {
      if (store.getState().chat.currentSessionId !== targetSessionId) return
      const rows = await window.api.chatGetMessages({ sessionId: targetSessionId })
      const live = getLiveMessages(targetSessionId)
      dispatch(setMessages(mergeDbAndLive(rows, live)))
    },
    [dispatch]
  )

  useEffect(() => {
    const refreshSessionMeta = (targetSessionId: string) => {
      void window.api.sessionGet(targetSessionId).then((s) => {
        if (s) dispatch(upsertSession(s))
      })
    }
    const offInbound = window.api.feishuOnInboundMessage(({ sessionId: inboundSessionId }) => {
      refreshSessionMeta(inboundSessionId)
      void reloadSessionMessagesFromDb(inboundSessionId)
    })
    return () => {
      offInbound()
    }
  }, [dispatch, reloadSessionMessagesFromDb])

  useEffect(() => {
    if (!sessionId) return
    const t = window.setTimeout(() => {
      void window.api.sessionBackfillAutoTitleIfNeeded({ sessionId }).then((s) => {
        if (s) dispatch(upsertSession(s))
      })
    }, 450)
    return () => window.clearTimeout(t)
  }, [sessionId, dispatch])

  const scrollBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  const scrollBottomThrottled = useMemo(
    () =>
      throttle(() => {
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (el) el.scrollTop = el.scrollHeight
        })
      }, 100),
    []
  )

  const streamingRequestId = sessionId ? runningSessions[sessionId]?.requestId ?? null : null

  const activePlanId = currentSession ? getPlanMeta(currentSession.metadata)?.planId ?? null : null
  const planDrafting = currentSession ? isPlanDrafting(currentSession.metadata) : false
  const sessionRunning = Boolean(sessionId && runningSessions[sessionId])
  const planExecutionUiState = useMemo(
    () =>
      derivePlanExecutionUiState({
        sessionRunning,
        planActionLoading,
        activePlanId,
        planDrafting
      }),
    [sessionRunning, planActionLoading, activePlanId, planDrafting]
  )

  const onToolConfirm = useCallback(
    (toolUseId: string, approved: boolean) => {
      const pending = sessionId ? pendingConfirmStore.find(sessionId, toolUseId) : undefined
      const requestId = pending?.requestId ?? streamingRequestId
      if (!requestId) return
      pendingConfirmStore.respond(requestId, toolUseId, approved)
      dispatch(setConfirmFocusToolUseId(null))
    },
    [dispatch, sessionId, streamingRequestId]
  )

  const onToolCancel = useCallback(
    (toolUseId: string) => {
      if (!streamingRequestId) return
      void window.api.toolCancel({ requestId: streamingRequestId, toolUseId })
    },
    [streamingRequestId]
  )

  const abort = useCallback(() => {
    abortRequestedRef.current = true
    if (streamingRequestId) {
      void window.api.claudeChatCancel({ requestId: streamingRequestId })
    }
  }, [streamingRequestId])

  const finishCancelled = useCallback(
    async (
      runSessionId: string,
      runRequestId: string,
      assistantId: string,
      contentState: ContentState,
      thinkingState: ThinkingState,
      toolCalls?: Message['toolCalls']
    ) => {
      const thinking = finalizeThinking(thinkingState)
      const contentSegments = finalizeContentSegments(contentState)
      const patch = {
        content: contentState.content,
        contentSegments,
        status: 'completed' as const,
        thinking,
        toolCalls
      }
      flushStreamPersist(runSessionId, assistantId)
      flushUiPatch(runSessionId, assistantId)
      routePatchMessage(runSessionId, assistantId, patch)
      await window.api.chatPatchMessage({
        messageId: assistantId,
        sessionId: runSessionId,
        patch
      })
      dispatch(setChatStatus({ status: 'completed', requestId: null, sessionId: runSessionId }))
      finishSessionRun(runSessionId, runRequestId, assistantId)
      clearLiveSession(runSessionId)
      message.info(CHAT_CANCELLED_MESSAGE)
      scrollBottom()
    },
    [dispatch, message, scrollBottom]
  )

  const sendInternal = useCallback(
    async (text: string, mode: ChatMode = chatMode) => {
      if (!sessionId || !cfg) {
        message.warning('请先选择会话并等待配置加载')
        return
      }
      const runSessionId = sessionId
      if (isSessionRunning(runSessionId)) {
        message.warning('当前会话已有任务在执行')
        return
      }
      const maxParallel = getMaxParallelChatSessions()
      if (countRunningSessions() >= maxParallel) {
        message.warning(`最多同时执行 ${maxParallel} 个会话，请稍后再试`)
        return
      }
      if (!cfg.apiKeyPresent) {
        message.warning('请先在设置中配置 API Key')
        return
      }
      const wikiConfig = cfg.wiki ?? DEFAULT_WIKI_CONFIG
      let sessionSkillsState = normalizeSessionSkillsState(currentSession?.skillsState ?? DEFAULT_SESSION_SKILLS_STATE)
      let chatText = text
      let wikiModeRun = false

      const wikiCmd = await parseWikiCommand(text, wikiConfig, sessionSkillsState)
      if (wikiCmd.type === 'command') {
        setSkillHints((prev) => [...prev, wikiCmd.hint])
        scrollBottom()
        if (wikiCmd.skillsState) {
          const updated = await window.api.sessionUpdate({ sessionId, skillsState: wikiCmd.skillsState })
          if (updated) dispatch(upsertSession(updated))
        }
        return
      }
      if (wikiCmd.type === 'run') {
        setSkillHints((prev) => [...prev, wikiCmd.hint])
        scrollBottom()
        chatText = wikiCmd.text
        sessionSkillsState = wikiCmd.skillsState
        wikiModeRun = true
        const updated = await window.api.sessionUpdate({
          sessionId,
          skillsState: wikiCmd.skillsState,
          metadata: patchSessionWikiState(currentSession?.metadata, { wikiModeActive: true })
        })
        if (updated) dispatch(upsertSession(updated))
      }

      const cmd = await parseSkillCommand(chatText, sessionSkillsState)
      if (cmd.type === 'command') {
        setSkillHints((prev) => [...prev, cmd.hint])
        scrollBottom()
        if (cmd.skillsState) {
          const updated = await window.api.sessionUpdate({ sessionId, skillsState: cmd.skillsState })
          if (updated) dispatch(upsertSession(updated))
        }
        return
      }

      const userMsg: Message = {
        id: crypto.randomUUID(),
        sessionId: runSessionId,
        role: 'user',
        content: chatText,
        timestamp: Date.now(),
        status: 'sent',
        schemaVersion: CURRENT_SCHEMA_VERSION
      }

      dispatch(addMessage(userMsg))

      const assistantId = crypto.randomUUID()
      const findAssistantRow = () =>
        getLiveMessages(runSessionId)?.find((m) => m.id === assistantId) ??
        store.getState().chat.messages.find((m) => m.id === assistantId)
      const assistantMsg: Message = {
        id: assistantId,
        sessionId: runSessionId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
        schemaVersion: CURRENT_SCHEMA_VERSION
      }
      dispatch(addMessage(assistantMsg))
      initLiveSessionFromStore(runSessionId)

      await window.api.chatAppendMessage(userMsg)
      await window.api.chatAppendMessage(assistantMsg)

      const requestId = crypto.randomUUID()
      registerSessionRun(runSessionId, requestId)
      abortRequestedRef.current = false
      dispatch(setChatStatus({ status: 'streaming', requestId, sessionId: runSessionId }))

      const historyForApi = [...store.getState().chat.messages]
      const useToolsApi = cfg.tools.enabled && filterBuiltinToolsForRenderer(cfg.tools).length > 0

      const activeSkills = await window.api.skillMatch({ userInput: chatText, sessionSkillsState })
      if (activeSkills.length > 0) {
        setSkillHints((prev) => [...prev, formatSkillHint(activeSkills, '已自动加载')])
        scrollBottom()
        const metadata = appendSkillActivationLog(currentSession?.metadata ?? {}, {
          skillNames: activeSkills.map((s) => s.meta.name),
          source: 'auto',
          userInput: chatText
        })
        void window.api.sessionUpdate({ sessionId, metadata }).then((updated) => {
          if (updated) dispatch(upsertSession(updated))
        })
      }

      const modelEntry = cfg.models.find((m) => m.name === cfg.model)
      const outputMaxTokens = resolveEffectiveOutputMaxTokens(cfg.model, cfg.models, cfg.maxTokens)
      const maxSystemChars = modelEntry ? Math.floor(modelEntry.maximumContext * 0.1) : undefined
      let systemPrompt = buildSystemPromptFromSkills(activeSkills)
      const wikiSchemaActive =
        wikiConfig.enabled &&
        (wikiModeRun || activeSkills.some((s) => s.meta.name === 'llm-wiki'))
      if (wikiSchemaActive) {
        const schema = await window.api.wikiGetSchema()
        systemPrompt = appendWikiSchemaToSystemPrompt(systemPrompt, schema?.content ?? null) ?? systemPrompt
      }
      if (maxSystemChars && systemPrompt) {
        systemPrompt = truncateSystemPrompt(systemPrompt, maxSystemChars)
      }

      if (abortRequestedRef.current) {
        await finishCancelled(
          runSessionId,
          requestId,
          assistantId,
          createContentState(assistantMsg.timestamp),
          createThinkingState(assistantMsg.timestamp)
        )
        return
      }

      let contentState = createContentState(assistantMsg.timestamp)
      let thinkingState = createThinkingState(assistantMsg.timestamp)

      if (useToolsApi) {
        const controller = createToolChatController({
          dispatch,
          assistantMessageId: assistantId,
          getRequestId: () => requestId,
          onRecordsChange: () => scrollBottomThrottled(),
          applyAssistantPatch: (patch) => routePatchMessage(runSessionId, assistantId, patch)
        })
        controller.subscribe()

        const unsubs: Array<() => void> = []
        const cleanup = () => {
          controller.unsubscribe()
          for (const u of unsubs) u()
          unsubs.length = 0
        }

        unsubs.push(
          window.api.claudeChatOnDelta((d) => {
            if (d.requestId !== requestId) return
            if (hasOpenThinkingSegment(thinkingState)) {
              thinkingState = closeOpenThinkingSegment(thinkingState)
            }
            contentState = appendContentDelta(contentState, d.text)
            routeStreamPatchMessage(runSessionId, assistantId, buildAssistantStreamPatch(thinkingState, contentState))
            scrollBottomThrottled()
          })
        )
        unsubs.push(
          window.api.claudeChatOnThinkingDelta((d) => {
            if (d.requestId !== requestId) return
            if (hasOpenContentSegment(contentState)) {
              contentState = closeOpenContentSegment(contentState)
            }
            thinkingState = appendThinkingDelta(thinkingState, d.text)
            routeStreamPatchMessage(runSessionId, assistantId, buildAssistantStreamPatch(thinkingState, contentState))
            scrollBottomThrottled()
          })
        )
        unsubs.push(
          window.api.toolOnUse((d) => {
            if (d.requestId !== requestId) return
            let changed = false
            if (hasOpenThinkingSegment(thinkingState)) {
              thinkingState = closeOpenThinkingSegment(thinkingState)
              changed = true
            }
            if (hasOpenContentSegment(contentState)) {
              contentState = closeOpenContentSegment(contentState)
              changed = true
            }
            if (!changed) return
            routeStreamPatchMessage(runSessionId, assistantId, buildAssistantStreamPatch(thinkingState, contentState))
          })
        )

        try {
          const sessionMeta =
            store.getState().session.list.find((x) => x.id === runSessionId)?.metadata ?? currentSession?.metadata
          const payload = buildToolChatPayload({
            requestId,
            sessionId: runSessionId,
            model: cfg.model,
            baseUrl: cfg.baseUrl || undefined,
            messages: historyForApi,
            toolsConfig: cfg.tools,
            maxTokens: outputMaxTokens,
            thinkingEnabled: cfg.thinkingEnabled,
            system: systemPrompt || undefined,
            chatMode: mode,
            sessionMetadata: sessionMeta,
            planRevisionFeedback: mode === 'plan' ? planRevisionFeedback : undefined
          })
          if (planRevisionFeedback) setPlanRevisionFeedback(undefined)
          const res = await window.api.claudeChatCreateWithTools(payload)
          if (!res.ok) {
            if (isChatCancelledError(res.error) || abortRequestedRef.current) {
              await finishCancelled(
                runSessionId,
                requestId,
                assistantId,
                contentState,
                thinkingState,
                findAssistantRow()?.toolCalls
              )
              return
            }
            flushStreamPersist(runSessionId, assistantId)
            flushUiPatch(runSessionId, assistantId)
            routePatchMessage(runSessionId, assistantId, {
              status: 'failed',
              content: contentState.content || res.error
            })
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId: runSessionId,
              patch: { status: 'failed', content: contentState.content || res.error }
            })
            dispatch(setChatStatus({ status: 'error', error: res.error, requestId: null, sessionId: runSessionId }))
            finishSessionRun(runSessionId, requestId, assistantId)
            clearLiveSession(runSessionId)
            message.error(res.error)
            return
          }
          const textOut = extractAssistantTextFromApiContent(res.content as unknown[]) || contentState.content
          if (textOut !== contentState.content) {
            contentState = { ...contentState, content: textOut }
          }
          flushStreamPersist(runSessionId, assistantId)
          flushUiPatch(runSessionId, assistantId)
          if (res.usage) {
            dispatch(setLastUsage(res.usage as LastUsage))
          }
          const assistantRow = findAssistantRow()
          const thinking = finalizeThinking(thinkingState)
          const contentSegments = finalizeContentSegments(contentState)
          routePatchMessage(runSessionId, assistantId, {
            content: textOut,
            contentSegments,
            status: 'completed',
            thinking,
            toolCalls: assistantRow?.toolCalls
          })
          await window.api.chatPatchMessage({
            messageId: assistantId,
            sessionId: runSessionId,
            patch: {
              content: textOut,
              contentSegments,
              status: 'completed',
              thinking,
              toolCalls: assistantRow?.toolCalls
            }
          })
          dispatch(setChatStatus({ status: 'completed', requestId: null, sessionId: runSessionId }))
          finishSessionRun(runSessionId, requestId, assistantId)
          clearLiveSession(runSessionId)
          if (mode === 'plan') {
            await reloadPlanState()
          }
          scrollBottom()
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e)
          if (isChatCancelledError(err) || abortRequestedRef.current) {
            await finishCancelled(
              runSessionId,
              requestId,
              assistantId,
              contentState,
              thinkingState,
              findAssistantRow()?.toolCalls
            )
            return
          }
          flushStreamPersist(runSessionId, assistantId)
          flushUiPatch(runSessionId, assistantId)
          routePatchMessage(runSessionId, assistantId, { status: 'failed', content: contentState.content || err })
          await window.api.chatPatchMessage({
            messageId: assistantId,
            sessionId: runSessionId,
            patch: { status: 'failed', content: contentState.content || err }
          })
          dispatch(setChatStatus({ status: 'error', error: err, requestId: null, sessionId: runSessionId }))
          finishSessionRun(runSessionId, requestId, assistantId)
          clearLiveSession(runSessionId)
          message.error(err)
        } finally {
          cleanup()
        }
        return
      }

      const basePayload = buildClaudePayload(historyForApi)

      await runClaudeChatStream(
        {
          requestId,
          model: cfg.model,
          baseUrl: cfg.baseUrl || undefined,
          messages: basePayload,
          system: systemPrompt || undefined,
          maxTokens: outputMaxTokens
        },
        {
          onDelta: (t) => {
            if (hasOpenThinkingSegment(thinkingState)) {
              thinkingState = closeOpenThinkingSegment(thinkingState)
            }
            contentState = appendContentDelta(contentState, t)
            routeStreamPatchMessage(runSessionId, assistantId, buildAssistantStreamPatch(thinkingState, contentState))
            scrollBottomThrottled()
          },
          onThinkingDelta: (t) => {
            if (hasOpenContentSegment(contentState)) {
              contentState = closeOpenContentSegment(contentState)
            }
            thinkingState = appendThinkingDelta(thinkingState, t)
            routeStreamPatchMessage(runSessionId, assistantId, buildAssistantStreamPatch(thinkingState, contentState))
            scrollBottomThrottled()
          },
          onDone: async (data) => {
            if (data?.usage) {
              dispatch(setLastUsage(data.usage as LastUsage))
            }
            flushStreamPersist(runSessionId, assistantId)
            flushUiPatch(runSessionId, assistantId)
            const thinking = finalizeThinking(thinkingState)
            const contentSegments = finalizeContentSegments(contentState)
            routePatchMessage(runSessionId, assistantId, {
              content: contentState.content,
              contentSegments,
              status: 'completed',
              thinking
            })
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId: runSessionId,
              patch: {
                content: contentState.content,
                contentSegments,
                status: 'completed',
                thinking
              }
            })
            dispatch(setChatStatus({ status: 'completed', requestId: null, sessionId: runSessionId }))
            finishSessionRun(runSessionId, requestId, assistantId)
            clearLiveSession(runSessionId)
            scrollBottom()
          },
          onError: async (err) => {
            if (isChatCancelledError(err) || abortRequestedRef.current) {
              await finishCancelled(runSessionId, requestId, assistantId, contentState, thinkingState)
              return
            }
            flushStreamPersist(runSessionId, assistantId)
            flushUiPatch(runSessionId, assistantId)
            routePatchMessage(runSessionId, assistantId, { status: 'failed', content: contentState.content || err })
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId: runSessionId,
              patch: { status: 'failed', content: contentState.content || err }
            })
            dispatch(setChatStatus({ status: 'error', error: err, requestId: null, sessionId: runSessionId }))
            finishSessionRun(runSessionId, requestId, assistantId)
            clearLiveSession(runSessionId)
            message.error(err)
          }
        }
      )
    },
    [
      cfg,
      currentSession,
      dispatch,
      sessionId,
      finishCancelled,
      message,
      chatMode,
      planRevisionFeedback,
      reloadPlanState
    ]
  )

  const send = useCallback(
    async (text: string, mode: ChatMode = chatMode) => {
      const pending = composerPendingAction.current
      if (pending === 'reject') {
        composerPendingAction.current = null
        const fb = text.startsWith(PLAN_REJECT_GUIDE) ? text.slice(PLAN_REJECT_GUIDE.length).trim() : text.trim()
        if (!fb) {
          message.warning('请填写拒绝原因')
          return
        }
        setPlanActionLoading(true)
        try {
          const res = await window.api.planReject({ sessionId: sessionId!, feedback: fb })
          if (!res.ok) {
            message.error(res.error)
            return
          }
          setPlanRevisionFeedback(fb)
          await reloadPlanState()
        } finally {
          setPlanActionLoading(false)
        }
        await sendInternal(text, 'plan')
        return
      }
      if (pending === 'revise') {
        composerPendingAction.current = null
        const fb = text.startsWith(PLAN_REVISE_GUIDE) ? text.slice(PLAN_REVISE_GUIDE.length).trim() : text.trim()
        if (fb) setPlanRevisionFeedback(fb)
        await sendInternal(text, 'plan')
        return
      }
      await sendInternal(text, mode)
    },
    [sendInternal, sessionId, message, reloadPlanState]
  )

  const runPlanWorkerWithoutNewUser = useCallback(async () => {
    if (!sessionId || !cfg) return
    const runSessionId = sessionId
    if (isSessionRunning(runSessionId)) {
      message.warning('当前会话已有任务在执行')
      return
    }
    const historyForApi = [...store.getState().chat.messages]
    const assistantId = crypto.randomUUID()
    const assistantMsg: Message = {
      id: assistantId,
      sessionId: runSessionId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      schemaVersion: CURRENT_SCHEMA_VERSION
    }
    dispatch(addMessage(assistantMsg))
    initLiveSessionFromStore(runSessionId)
    await window.api.chatAppendMessage(assistantMsg)
    const requestId = crypto.randomUUID()
    registerSessionRun(runSessionId, requestId)
    dispatch(setChatStatus({ status: 'streaming', requestId, sessionId: runSessionId }))
    const modelEntry = cfg.models.find((m) => m.name === cfg.model)
    const outputMaxTokens = resolveEffectiveOutputMaxTokens(cfg.model, cfg.models, cfg.maxTokens)
    const sessionMeta = store.getState().session.list.find((x) => x.id === runSessionId)?.metadata
    const payload = buildToolChatPayload({
      requestId,
      sessionId: runSessionId,
      model: cfg.model,
      baseUrl: cfg.baseUrl || undefined,
      messages: historyForApi,
      toolsConfig: cfg.tools,
      maxTokens: outputMaxTokens,
      thinkingEnabled: cfg.thinkingEnabled,
      chatMode: 'plan',
      sessionMetadata: sessionMeta
    })
    const res = await window.api.claudeChatCreateWithTools(payload)
    if (!res.ok) {
      message.error(res.error)
      finishSessionRun(runSessionId, requestId, assistantId)
      return
    }
    const textOut = extractAssistantTextFromApiContent(res.content as unknown[])
    if (res.usage) {
      dispatch(setLastUsage(res.usage as LastUsage))
    }
    routePatchMessage(runSessionId, assistantId, { content: textOut, status: 'completed' })
    await window.api.chatPatchMessage({
      messageId: assistantId,
      sessionId: runSessionId,
      patch: { content: textOut, status: 'completed' }
    })
    dispatch(setChatStatus({ status: 'completed', requestId: null, sessionId: runSessionId }))
    finishSessionRun(runSessionId, requestId, assistantId)
    clearLiveSession(runSessionId)
    void reloadPlanState()
  }, [sessionId, cfg, dispatch, message, reloadPlanState])

  const handlePlanApprove = useCallback(
    async (options?: { cancelExecuting?: boolean }) => {
      if (!sessionId) return
      setPlanActionLoading(true)
      try {
        const res = await window.api.planApprove({
          sessionId,
          cancelExecuting: options?.cancelExecuting
        })
        if (!res.ok) {
          message.error(res.error)
          return
        }
        await reloadPlanState()
        if (res.autoExecute) {
          await runPlanWorkerWithoutNewUser()
        }
      } finally {
        setPlanActionLoading(false)
      }
    },
    [sessionId, runPlanWorkerWithoutNewUser, message, reloadPlanState]
  )

  const requestComposerFocus = useCallback((req: ComposerFocusRequest) => {
    if (req.prefill.startsWith(PLAN_REJECT_GUIDE)) composerPendingAction.current = 'reject'
    else if (req.prefill.startsWith(PLAN_REVISE_GUIDE)) composerPendingAction.current = 'revise'
    else composerPendingAction.current = null
    composerRef.current?.setDraft(req.prefill)
    if (req.mode) composerRef.current?.setChatMode(req.mode)
    composerRef.current?.focus()
  }, [])

  const handlePlanCancel = useCallback(async () => {
    if (!sessionId) return
    setPlanActionLoading(true)
    try {
      if (isSessionRunning(sessionId)) {
        abortRequestedRef.current = true
        abortSessionRun(sessionId)
        dispatch(setChatStatus({ status: 'completed', requestId: null, sessionId }))
      }
      const res = await window.api.planCancel({ sessionId })
      if (!res.ok) message.error(res.error)
      else {
        message.success('计划已取消')
        await reloadPlanState()
      }
    } finally {
      setPlanActionLoading(false)
    }
  }, [sessionId, dispatch, message, reloadPlanState])

  const handlePlanResume = useCallback(async () => {
    if (!sessionId || isSessionRunning(sessionId)) return
    setPlanActionLoading(true)
    try {
      await runPlanWorkerWithoutNewUser()
    } finally {
      setPlanActionLoading(false)
    }
  }, [sessionId, runPlanWorkerWithoutNewUser])

  useEffect(() => {
    planPanelActionsStore.set({
      requestComposerFocus,
      onApproveAndExecute: handlePlanApprove,
      onPlanResume: handlePlanResume,
      onPlanCancel: handlePlanCancel,
      onPlanRejectWithFeedback: async (feedback: string) => {
        composerPendingAction.current = 'reject'
        composerRef.current?.setDraft(`${PLAN_REJECT_GUIDE}${feedback}`)
        composerRef.current?.setChatMode('plan')
        composerRef.current?.focus()
      },
      planActionLoading,
      planExecutionUiState
    })
    return () => planPanelActionsStore.set(null)
  }, [
    requestComposerFocus,
    handlePlanApprove,
    handlePlanResume,
    handlePlanCancel,
    planActionLoading,
    planExecutionUiState
  ])

  const running = sessionRunning

  useEffect(() => {
    const onIngest = (e: Event) => {
      const detail = (e as CustomEvent<{ rawRelPath: string }>).detail
      if (!detail?.rawRelPath) return
      void send(`/wiki ingest ${detail.rawRelPath}`)
    }
    window.addEventListener('sa-wiki-ingest-request', onIngest)
    return () => window.removeEventListener('sa-wiki-ingest-request', onIngest)
  }, [send])

  const handleArchiveToWiki = useCallback(
    (assistantContent: string) => {
      if (!sessionId) return
      const wikiRoot = (cfg?.wiki?.rootPath ?? DEFAULT_WIKI_CONFIG.rootPath).replace(/\\/g, '/').replace(/^\/+/, '')
      const date = new Date().toISOString().slice(0, 10)
      const relPath = `${wikiRoot}/wiki/queries/${date}-archive.md`
      const excerpt = assistantContent.trim().slice(0, 12000)
      void window.api
        .sessionUpdate({
          sessionId,
          metadata: appendArchivedQuery(currentSession?.metadata, relPath)
        })
        .then((updated) => {
          if (updated) dispatch(upsertSession(updated))
        })
      void send(
        `/wiki query 请将以下助手回答归档为 Wiki 新页（建议 wiki/queries/${date}-archive.md），更新 index 与 log，并确保正文结构清晰：\n\n${excerpt}`
      )
    },
    [send, sessionId, cfg?.wiki?.rootPath, currentSession?.metadata, dispatch]
  )

  const handleOpenFile = useCallback(
    (relPath: string) => {
      const wikiRoot = cfg?.wiki?.rootPath ?? 'llm-wiki'
      requestFilePaneSelect({ relPath, preferWiki: isUnderWikiRoot(relPath, wikiRoot) })
      void openFile(relPath).catch((e) => {
        message.error(e instanceof Error ? e.message : String(e))
      })
    },
    [message, openFile, cfg?.wiki?.rootPath]
  )

  const toolsInteractive = useMemo(
    () =>
      cfg?.tools.enabled && streamingRequestId && streamingAssistantId
        ? {
            requestId: streamingRequestId,
            confirmMode: cfg.tools.confirmMode,
            onToolConfirm,
            onToolCancel
          }
        : undefined,
    [
      cfg?.tools.enabled,
      cfg?.tools.confirmMode,
      streamingRequestId,
      streamingAssistantId,
      onToolConfirm,
      onToolCancel
    ]
  )

  return (
    <div className="chat-view">
      <div ref={scrollRef} className="chat-scroll">
        <SkillHintBubble hints={skillHints} />
        {!sessionId ? (
          <div className="chat-empty">
            <div className="chat-empty-title">选择或创建一个会话</div>
            <Text type="secondary">在左侧开始与 AI 助手对话</Text>
          </div>
        ) : messages.length === 0 && skillHints.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">开始对话</div>
            <Text type="secondary">输入问题，或尝试 /skill、/wiki 命令</Text>
          </div>
        ) : (
          messages.map((m) => (
            <ChatBubble
              key={m.id}
              message={m}
              toolsInteractive={m.id === streamingAssistantId ? toolsInteractive : undefined}
              focusToolUseId={m.id === streamingAssistantId ? confirmFocusToolUseId : undefined}
              onOpenFile={handleOpenFile}
              wikiRootPath={cfg?.wiki?.rootPath ?? 'llm-wiki'}
              showArchiveToWiki={Boolean(cfg?.wiki?.enabled && m.role === 'assistant' && m.status === 'completed' && m.content.trim())}
              onArchiveToWiki={() => handleArchiveToWiki(m.content)}
            />
          ))
        )}
      </div>
      <MessageInput
        ref={composerRef}
        disabled={!sessionId}
        running={running}
        modelLabel={cfg?.model}
        chatMode={chatMode}
        defaultChatMode={cfg?.defaultChatMode ?? DEFAULT_CHAT_MODE}
        onChatModeChange={setChatMode}
        onSend={send}
        onAbort={abort}
      />
    </div>
  )
}
