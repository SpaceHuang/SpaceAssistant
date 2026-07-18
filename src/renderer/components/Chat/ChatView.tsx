import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Tag } from 'antd'
import { MessageSquare, MessagesSquare } from 'lucide-react'
import { useTypedSelector, useAppDispatch } from '../../hooks'
import { patchMessage, removeMessage, restoreLastUsage, setChatStatus, setConfirmFocusToolUseId, setMessages, setScrollToMessageId, setSession } from '../../store/chatSlice'
import { openSettings } from '../../store/configSlice'
import type { LastUsage } from '../../store/chatSlice'
import {
  clearLiveSession,
  countRunningSessions,
  finishSessionRun,
  flushStreamPersist,
  flushUiPatch,
  getLiveMessages,
  getToolChatController,
  initLiveSessionFromStore,
  getMaxParallelChatSessions,
  mergeDbAndLive,
  abortSessionRun,
  registerSessionRun,
  registerToolChatController,
  removeLiveMessage,
  resolveSessionMessagesForApi,
  routeAddMessage,
  routePatchMessage,
  routeStreamPatchMessage,
  isSessionRunning,
  unregisterToolChatController
} from '../../services/chatRunnerService'
import { pendingConfirmStore } from '../../services/pendingConfirmStore'
import { resolveMessageToolsInteractive } from '../../services/resolveMessageToolsInteractive'
import { usePendingConfirmSnapshot } from '../../hooks/usePendingConfirmSnapshot'
import { usePendingWriteDirConfirmSnapshot } from '../../hooks/usePendingWriteDirConfirmSnapshot'
import { pendingWriteDirConfirmStore } from '../../services/pendingWriteDirConfirmStore'
import { WriteDirConfirmPanel } from './WriteDirConfirmPanel'
import { usePendingArtifactDecisionSnapshot } from '../../hooks/usePendingArtifactDecisionSnapshot'
import { pendingArtifactDecisionStore } from '../../services/pendingArtifactDecisionStore'
import { ArtifactDecisionCard } from './ArtifactDecisionCard'
import { shouldShowLegacyWriteDirUi } from './legacyWriteDirUi'
import { upsertSession } from '../../store/sessionSlice'
import { store } from '../../store'
import { runClaudeChatStream } from '../../services/chatStreamService'
import { applyContextUsageUpdate } from '../../services/contextUsageStreamService'
import {
  computeEstimatedOccupancy,
  estimateThinkingTokensFromMessage,
  estimateTokensFromHistoryImages,
  estimateTokensFromImageAttachments,
  resolveEffectiveMaximumContext
} from '../../../shared/contextUsageEstimate'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { resolveChatLocale } from '../../utils/resolveChatLocale'
import {
  buildToolChatPayload,
  createToolChatController
} from '../../services/chatToolSessionService'
import type { ToolConfirmOptions } from '../../../shared/toolConfirm'
import { reconcileAssistantStreamOnComplete } from '../../../shared/assistantContentReconcile'
import { ComposerModelPicker } from './ComposerModelPicker'
import { resolveSessionModelBinding } from '../../services/sessionModelBinding'
import type { ChatModelOption } from '../../../shared/llmModelConfig'
import { parseSkillCommand } from '../../services/skillCommandService'
import { parseTestCardsCommand } from '../../services/testCardsCommandService'
import { runTestCardsPreview } from '../../services/testCardsPreviewService'
import { parseTestPopCommand } from '../../services/testPopCommandService'
import { parseWikiCommand } from '../../services/wikiCommandService'
import { appendWikiSchemaToSystemPrompt } from '../../services/wikiPrompt'
import { appendArchivedQuery, patchSessionWikiState } from '../../services/wikiSessionState'
import { requestFilePaneSelect, isUnderWikiRoot } from '../../services/filePaneNavigation'
import { ensureWorkDirForSession } from '../../services/workDirSessionSync'
import { appendSkillActivationLog } from '../../services/skillActivationLog'
import { activateBrowserRecoverySkillIfNeeded } from '../../services/browserRecoverySkillService'
import { activateRecoverySkillInState, BROWSER_SETUP_RECOVERY_SKILL } from '../../../shared/browserDependencyRecovery'
import { clearChatLaunchIntent } from '../../store/chatLaunchSlice'
import { filterBuiltinToolsForRenderer } from '../../../shared/toolsConfigFilter'
import { buildSystemPromptFromSkills, buildSkillRouteSignature, formatSkillRouteHint, truncateSystemPrompt } from '../../../shared/skillPrompt'
import { appendSkillHintRecord, createSkillHintRecord, createSkillHintSystemMessage } from '../../../shared/skillHintRecords'
import type { ChatImageAttachment, Message, SkillActivationSource, SkillRouteRecentMessage } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_LLM_TEMPERATURE, DEFAULT_SESSION_SKILLS_STATE, DEFAULT_WIKI_CONFIG, normalizeSessionSkillsState, type SessionSkillsState } from '../../../shared/domainTypes'
import { resolveEffectiveOutputMaxTokens } from '../../../shared/llm/outputMaxTokens'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import { ChatBubble } from './ChatBubble'
import { MessageInput, type MessageInputHandle } from './MessageInput'
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
import { scrollIntoViewWithMotionPreference } from '../../utils/motionPreference'
import arrowDownLineRaw from '../../assets/arrow_down_line.svg?raw'
import { isChatScrollNearBottom, scrollChatToBottom } from '../../utils/chatScroll'
import { patchSvg } from '../../utils/patchSvg'

const scrollToLatestIconSvg = patchSvg(arrowDownLineRaw, 16)
import { useChatMessageEnter } from '../../hooks/useChatMessageEnter'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import {
  countQueuedUserMessages,
  filterMessagesForChatApi,
  getNextQueuedUserMessage,
  MAX_CHAT_MESSAGE_QUEUE_SIZE
} from '../../../shared/chatMessageQueue'
import { classifyOutboundMessage } from '../../services/chatOutboundClassifier'
import { formatToolLabel } from './toolCallDisplay'
import {
  formatStreamingElapsed,
  resolveStreamingActivityStatus
} from '../../../shared/streamingActivityStatus'
import { ChatMessageListSearch } from '../Search/ChatMessageListSearch'
import {
  requestNeedsVisionModel,
  resolveVisionRouteForImageSend
} from '../../../shared/visionModelRouting'

type SendInternalOptions = {
  skipUserMessage?: boolean
  targetSessionId?: string
  /** 会话执行中仍允许执行的即时命令（/skill list 等） */
  bypassRunningGuard?: boolean
  attachments?: ChatImageAttachment[]
  currentUserMessageId?: string
}

function buildClaudePayload(history: Message[]) {
  return filterMessagesForChatApi(history).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string' ? m.content : ''
  }))
}

export function ChatView() {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('chat')
  const { t: tErrors } = useTypedTranslation('errors')
  const { t: tContextUsage } = useTypedTranslation('contextUsage')
  const { openFile } = useDetailPanel()
  const dispatch = useAppDispatch()
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const messages = useTypedSelector((s) => s.chat.messages)
  const composerHistoryMessages = useMemo(() => {
    if (!sessionId) return []
    return filterMessagesForChatApi(messages.filter((m) => m.sessionId === sessionId))
  }, [messages, sessionId])
  const runningSessions = useTypedSelector((s) => s.chat.runningSessions)
  const confirmFocusToolUseId = useTypedSelector((s) => s.chat.confirmFocusToolUseId)
  const scrollToMessageId = useTypedSelector((s) => s.chat.scrollToMessageId)
  const cfg = useTypedSelector((s) => s.config.config)
  const currentSession = useTypedSelector((s) => s.session.list.find((x) => x.id === s.chat.currentSessionId))
  const sessionBinding = useMemo(
    () => (cfg ? resolveSessionModelBinding(cfg, currentSession) : null),
    [cfg, currentSession]
  )
  const chatModelName = sessionBinding?.modelName ?? cfg?.model ?? ''
  const chatLlmServiceId = sessionBinding?.llmServiceId
  const chatBaseUrl = useMemo(() => {
    if (!cfg) return undefined
    const svc = cfg.llmServices.find((s) => s.id === chatLlmServiceId)
    return svc?.baseUrl || cfg.baseUrl || undefined
  }, [cfg, chatLlmServiceId])
  const useToolsApi = useMemo(
    () =>
      Boolean(
        cfg?.tools.enabled &&
          filterBuiltinToolsForRenderer(cfg.tools, cfg.feishu, cfg.browser).length > 0
      ),
    [cfg]
  )
  const chatLaunchIntent = useTypedSelector((s) => s.chatLaunch.intent)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const composerRef = useRef<MessageInputHandle>(null)
  const abortRequestedRef = useRef(false)
  const lastSkillRouteSignatureRef = useRef('')
  const prevRunningSessionsRef = useRef<Record<string, true>>({})
  const drainingQueueRef = useRef(false)
  const sendInternalRef = useRef<
    (text: string, skillsStateOverride?: SessionSkillsState, options?: SendInternalOptions) => Promise<void>
  >(async () => {})
  const [testPreviewMessageIds, setTestPreviewMessageIds] = useState<Set<string>>(() => new Set())
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)

  const streamingAssistantId = useMemo(
    () => messages.find((m) => m.role === 'assistant' && m.status === 'streaming')?.id,
    [messages]
  )

  const streamingAssistant = useMemo(
    () => messages.find((m) => m.id === streamingAssistantId),
    [messages, streamingAssistantId]
  )

  const [runningClock, setRunningClock] = useState(() => Date.now())

  const messageIds = useMemo(() => messages.map((m) => m.id), [messages])
  const enterMessageId = useChatMessageEnter(sessionId, messageIds)

  useEffect(() => {
    lastSkillRouteSignatureRef.current = ''
    setTestPreviewMessageIds(new Set())
    stickToBottomRef.current = true
    setShowScrollToLatest(false)
  }, [sessionId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const syncScrollStickiness = () => {
      const nearBottom = isChatScrollNearBottom(el)
      stickToBottomRef.current = nearBottom
      setShowScrollToLatest(!nearBottom)
    }
    syncScrollStickiness()
    el.addEventListener('scroll', syncScrollStickiness, { passive: true })
    return () => el.removeEventListener('scroll', syncScrollStickiness)
  }, [sessionId, messages.length])

  const handleScrollToLatest = useCallback(() => {
    const el = scrollRef.current
    if (el) scrollChatToBottom(el, { force: true, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    if (!sessionId) {
      dispatch(setMessages([]))
      return
    }
    let cancelled = false
    void window.api.chatGetMessages({ sessionId }).then((rows) => {
      if (cancelled) return
      const live = getLiveMessages(sessionId)
      const pendingInStore = store.getState().chat.messages.filter((m) => m.sessionId === sessionId)
      dispatch(setMessages(mergeDbAndLive(mergeDbAndLive(rows, live), pendingInStore)))
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, dispatch])

  useEffect(() => {
    if (!sessionId) {
      dispatch(restoreLastUsage(null))
      return
    }
    let cancelled = false
    void window.api.usageGet(sessionId).then((cached) => {
      if (!cancelled) dispatch(restoreLastUsage(cached ?? null))
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, dispatch])

  useEffect(() => {
    if (!scrollToMessageId || messages.length === 0) return
    const el = scrollRef.current?.querySelector(`[data-message-id="${scrollToMessageId}"]`)
    if (el) {
      scrollIntoViewWithMotionPreference(el, { block: 'center', behavior: 'smooth' })
      dispatch(setScrollToMessageId(null))
    }
  }, [scrollToMessageId, messages, dispatch])

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

  const scrollBottom = useCallback((force = false) => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      scrollChatToBottom(el, { force, stickToBottom: stickToBottomRef.current })
    })
  }, [])

  const scrollBottomThrottled = useMemo(
    () =>
      throttle((force = false) => {
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (!el) return
          scrollChatToBottom(el, { force, stickToBottom: stickToBottomRef.current })
        })
      }, 100),
    []
  )

  const streamingRequestId = sessionId ? runningSessions[sessionId]?.requestId ?? null : null

  const sessionRunning = Boolean(sessionId && runningSessions[sessionId])

  useEffect(() => {
    if (!sessionRunning) return
    setRunningClock(Date.now())
    const timer = window.setInterval(() => setRunningClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [sessionRunning])

  const runningActivity = useMemo(() => {
    if (!streamingAssistant) return null
    return resolveStreamingActivityStatus({
      message: streamingAssistant,
      formatToolLabel: (toolName, input) => formatToolLabel(toolName, input, t),
      t,
      now: runningClock
    })
  }, [streamingAssistant, t, runningClock])

  const onToolConfirm = useCallback(
    (toolUseId: string, approved: boolean, options?: ToolConfirmOptions) => {
      const pending = sessionId ? pendingConfirmStore.find(sessionId, toolUseId) : undefined
      const requestId = pending?.requestId ?? streamingRequestId
      if (!requestId) return
      getToolChatController(requestId)?.applyConfirmOutcome(toolUseId, approved)
      pendingConfirmStore.respond(requestId, toolUseId, approved, options)
      dispatch(setConfirmFocusToolUseId(null))
    },
    [dispatch, sessionId, streamingRequestId]
  )

  const onToolCancel = useCallback(
    (toolUseId: string) => {
      const pending = sessionId ? pendingConfirmStore.find(sessionId, toolUseId) : undefined
      const requestId = pending?.requestId ?? streamingRequestId
      if (!requestId) return
      void window.api.toolCancel({ requestId, toolUseId })
    },
    [sessionId, streamingRequestId]
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
      scrollBottom(true)
    },
    [dispatch, message, scrollBottom]
  )

  const { t: tChat } = useTypedTranslation('chat')

  const persistSkillHintSystemMessage = useCallback(
    async (targetSessionId: string, text: string, shownAt = Date.now()) => {
      const msg = createSkillHintSystemMessage(targetSessionId, text, shownAt)
      routeAddMessage(targetSessionId, msg)
      await window.api.chatAppendMessage(msg)
      scrollBottom(true)
    },
    [dispatch, scrollBottom]
  )

  const enqueueChatMessage = useCallback(
    async (runSessionId: string, text: string, attachments?: ChatImageAttachment[]) => {
      const chatText = text.trim()
      if (!chatText) return

      const queuedCount = countQueuedUserMessages(store.getState().chat.messages, runSessionId)
      if (queuedCount >= MAX_CHAT_MESSAGE_QUEUE_SIZE) {
        message.warning(t('chatView.warnings.queueFull', { max: MAX_CHAT_MESSAGE_QUEUE_SIZE }))
        return
      }

      const userMsg: Message = {
        id: crypto.randomUUID(),
        sessionId: runSessionId,
        role: 'user',
        content: chatText,
        attachments: attachments?.length ? attachments : undefined,
        timestamp: Date.now(),
        status: 'queued',
        schemaVersion: CURRENT_SCHEMA_VERSION
      }
      routeAddMessage(runSessionId, userMsg)
      stickToBottomRef.current = true
      await window.api.chatAppendMessage(userMsg)
      scrollBottom(true)
    },
    [dispatch, message, scrollBottom, t]
  )

  const cancelQueuedMessage = useCallback(
    async (messageId: string) => {
      const msg = store.getState().chat.messages.find((m) => m.id === messageId)
      if (!msg || msg.role !== 'user' || msg.status !== 'queued') return

      const result = await window.api.chatDeleteQueuedMessage({
        messageId,
        sessionId: msg.sessionId
      })
      if (!result.ok) {
        message.warning(t('chatView.warnings.cancelQueueFailed'))
        return
      }

      dispatch(removeMessage(messageId))
      removeLiveMessage(msg.sessionId, messageId)
    },
    [dispatch, message, t]
  )

  const drainQueueForSession = useCallback(
    async (runSessionId: string) => {
      if (drainingQueueRef.current || isSessionRunning(runSessionId)) return

      const next = getNextQueuedUserMessage(store.getState().chat.messages, runSessionId)
      if (!next) return

      drainingQueueRef.current = true
      try {
        dispatch(patchMessage({ id: next.id, patch: { status: 'sent' } }))
        await window.api.chatPatchMessage({
          messageId: next.id,
          sessionId: runSessionId,
          patch: { status: 'sent' }
        })
        await sendInternalRef.current(next.content, undefined, {
          targetSessionId: runSessionId,
          skipUserMessage: true,
          attachments: next.attachments,
          currentUserMessageId: next.id
        })
      } finally {
        drainingQueueRef.current = false
      }
    },
    [dispatch]
  )

  useEffect(() => {
    const prev = prevRunningSessionsRef.current
    const currKeys = new Set(Object.keys(runningSessions))
    for (const sid of new Set([...Object.keys(prev), ...currKeys])) {
      if (prev[sid] && !currKeys.has(sid)) {
        void drainQueueForSession(sid)
      }
    }
    const nextPrev: Record<string, true> = {}
    for (const sid of currKeys) nextPrev[sid] = true
    prevRunningSessionsRef.current = nextPrev
  }, [runningSessions, drainQueueForSession])

  const sendInternal = useCallback(
    async (text: string, skillsStateOverride?: SessionSkillsState, options?: SendInternalOptions) => {
      const runSessionId = options?.targetSessionId ?? sessionId

      // /test-pop 无需 API key、会话或 cfg，优先处理
      const testPopCmd = parseTestPopCommand(text)
      if (testPopCmd.type === 'command') {
        if (runSessionId) {
          await persistSkillHintSystemMessage(runSessionId, testPopCmd.hint)
        } else {
          message.info(testPopCmd.hint)
        }
        return
      }
      if (testPopCmd.type === 'run') {
        await window.api.testPopShow()
        message.info('浮动通知已弹出（测试数据），点击通知或手动关闭 ✕ 按钮关闭。')
        return
      }

      if (!runSessionId || !cfg) {
        message.warning(t('chatView.warnings.selectSession'))
        return
      }

      const runSession =
        store.getState().session.list.find((x) => x.id === runSessionId) ??
        (currentSession?.id === runSessionId ? currentSession : undefined)

      if (runSession) {
        const sync = await ensureWorkDirForSession(runSession, cfg, dispatch)
        if (!sync.ok) {
          message.error(formatUserFacingError(sync.error))
          return
        }
      }

      if (isSessionRunning(runSessionId) && !options?.bypassRunningGuard) {
        message.warning(t('chatView.warnings.sessionRunning'))
        return
      }
      const maxParallel = getMaxParallelChatSessions()
      if (countRunningSessions() >= maxParallel) {
        message.warning(t('chatView.warnings.maxParallel', { max: maxParallel }))
        return
      }

      const testCmd = parseTestCardsCommand(text)
      if (testCmd.type === 'command') {
        await persistSkillHintSystemMessage(runSessionId, testCmd.hint)
        return
      }
      if (testCmd.type === 'run') {
        await runTestCardsPreview({
          sessionId: runSessionId,
          text,
          dispatch,
          scrollBottom,
          onPreviewMessageId: (messageId) => {
            setTestPreviewMessageIds((prev) => new Set([...prev, messageId]))
          },
          persistSystemHint: (hint) => persistSkillHintSystemMessage(runSessionId, hint)
        })
        return
      }

      if (!cfg.apiKeyPresent) {
        message.warning(t('chatView.warnings.apiKeyMissing'))
        dispatch(openSettings({ tab: 'models' }))
        return
      }
      const wikiConfig = cfg.wiki ?? DEFAULT_WIKI_CONFIG
      let sessionSkillsState = normalizeSessionSkillsState(
        skillsStateOverride ?? runSession?.skillsState ?? DEFAULT_SESSION_SKILLS_STATE
      )
      let chatText = text
      let wikiModeRun = false

      const wikiCmd = await parseWikiCommand(text, wikiConfig, sessionSkillsState)
      if (wikiCmd.type === 'command') {
        await persistSkillHintSystemMessage(runSessionId, wikiCmd.hint)
        if (wikiCmd.skillsState) {
          const updated = await window.api.sessionUpdate({ sessionId: runSessionId, skillsState: wikiCmd.skillsState })
          if (updated) dispatch(upsertSession(updated))
        }
        return
      }
      if (wikiCmd.type === 'run') {
        await persistSkillHintSystemMessage(runSessionId, wikiCmd.hint)
        chatText = wikiCmd.text
        sessionSkillsState = wikiCmd.skillsState
        wikiModeRun = true
        const updated = await window.api.sessionUpdate({
          sessionId: runSessionId,
          skillsState: wikiCmd.skillsState,
          metadata: patchSessionWikiState(runSession?.metadata, { wikiModeActive: true })
        })
        if (updated) dispatch(upsertSession(updated))
      }

      const cmd = await parseSkillCommand(chatText, sessionSkillsState)
      if (cmd.type === 'command') {
        await persistSkillHintSystemMessage(runSessionId, cmd.hint)
        if (cmd.skillsState) {
          const updated = await window.api.sessionUpdate({ sessionId: runSessionId, skillsState: cmd.skillsState })
          if (updated) dispatch(upsertSession(updated))
        }
        return
      }

      if ((options?.attachments?.length ?? 0) > 0 && !useToolsApi) {
        message.error(tErrors('chat.imagesRequireTools'))
        return
      }

      const userMsg: Message = {
        id: crypto.randomUUID(),
        sessionId: runSessionId,
        role: 'user',
        content: chatText,
        attachments: options?.attachments?.length ? options.attachments : undefined,
        timestamp: Date.now(),
        status: 'sent',
        schemaVersion: CURRENT_SCHEMA_VERSION
      }

      if (!options?.skipUserMessage) {
        routeAddMessage(runSessionId, userMsg)
        stickToBottomRef.current = true
      }

      const sessionMessages = await resolveSessionMessagesForApi(runSessionId)
      const historyForApi = options?.skipUserMessage
        ? filterMessagesForChatApi(sessionMessages)
        : filterMessagesForChatApi([...sessionMessages.filter((m) => m.id !== userMsg.id), userMsg])

      if (!options?.skipUserMessage) {
        await window.api.chatAppendMessage(userMsg)
      }

      const currentUserMessageId = options?.skipUserMessage
        ? (options.currentUserMessageId ??
          [...sessionMessages]
            .reverse()
            .find((m) => m.sessionId === runSessionId && m.role === 'user' && m.status !== 'queued')?.id ??
          '')
        : userMsg.id

      const modelEntry = cfg.models.find((m) => m.name === chatModelName)
      let requestModel = chatModelName
      let requestLlmServiceId = chatLlmServiceId
      let effectiveModelForUsage: string | undefined

      if (requestNeedsVisionModel(historyForApi)) {
        const visionRoute = resolveVisionRouteForImageSend(cfg, chatModelName, chatLlmServiceId)
        if (!visionRoute.ok) {
          message.error(tErrors('chat.noVisionModel'))
          return
        }
        if (visionRoute.switched) {
          requestModel = visionRoute.modelName
          requestLlmServiceId = visionRoute.llmServiceId
          effectiveModelForUsage = visionRoute.modelName
        }
      }

      const requestBaseUrl = (() => {
        const svc = cfg.llmServices.find((s) => s.id === requestLlmServiceId)
        return svc?.baseUrl || cfg.baseUrl || undefined
      })()
      const requestModelEntry = cfg.models.find((m) => m.name === requestModel) ?? modelEntry
      const outputMaxTokens = resolveEffectiveOutputMaxTokens(requestModel, cfg.models)
      const maxSystemChars = requestModelEntry ? Math.floor(requestModelEntry.maximumContext * 0.1) : undefined

      const lastUsage = store.getState().chat.lastUsage
      const pendingAttachments = options?.skipUserMessage ? undefined : userMsg.attachments
      const pendingImageTokens = pendingAttachments?.length
        ? estimateTokensFromImageAttachments(pendingAttachments)
        : 0
      const historyImageTokens = estimateTokensFromHistoryImages(historyForApi)
      const lastAssistantThinking = (() => {
        for (let i = historyForApi.length - 1; i >= 0; i--) {
          const m = historyForApi[i]
          if (m?.role === 'assistant' && m.thinking) return m.thinking
        }
        return undefined
      })()
      const thinkingTokensToExclude = estimateThinkingTokensFromMessage(lastAssistantThinking)
      if (requestModelEntry) {
        const cap = resolveEffectiveMaximumContext(requestModel, requestModelEntry.maximumContext)
        const occupancy = lastUsage
          ? computeEstimatedOccupancy(lastUsage, { thinkingTokensToExclude })
          : 0
        if (cap > 0 && historyImageTokens + pendingImageTokens + occupancy > cap * 0.8) {
          message.warning(
            tContextUsage('sendWarning', {
              imageTokens: historyImageTokens + pendingImageTokens,
              percent: Math.round(((historyImageTokens + pendingImageTokens + occupancy) / cap) * 100)
            })
          )
        }
      }

      const requestId = crypto.randomUUID()
      registerSessionRun(runSessionId, requestId)
      abortRequestedRef.current = false
      dispatch(setChatStatus({ status: 'streaming', requestId, sessionId: runSessionId }))

      const recentMessages: SkillRouteRecentMessage[] = filterMessagesForChatApi(historyForApi)
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      const routeResult = await window.api.skillRoute({
        userInput: chatText,
        sessionSkillsState,
        sessionId: runSessionId,
        sessionMetadata: runSession?.metadata,
        recentMessages,
        model: chatModelName
      })
      const activeSkills = routeResult.skills
      let skillHintTimestamp: number | undefined
      let routeSkillHintText: string | undefined
      if (activeSkills.length > 0) {
        const routeSignature = buildSkillRouteSignature(activeSkills, routeResult.meta.sources)
        if (routeSignature !== lastSkillRouteSignatureRef.current) {
          lastSkillRouteSignatureRef.current = routeSignature
          skillHintTimestamp = Date.now()
          routeSkillHintText = formatSkillRouteHint(activeSkills, routeResult.meta.sources)
        }
        const logSource: SkillActivationSource =
          activeSkills.map((s) => routeResult.meta.sources[s.meta.name]).find((src) => src === 'llm') ??
          routeResult.meta.sources[activeSkills[0]!.meta.name] ??
          'llm'
        const metadata = appendSkillActivationLog(runSession?.metadata ?? {}, {
          skillNames: activeSkills.map((s) => s.meta.name),
          source: logSource,
          userInput: chatText,
          llmRecommended: routeResult.meta.llmRecommended,
          routingFailed: routeResult.meta.routingFailed,
          routingError: routeResult.meta.routingError,
          routingRequestId: routeResult.meta.routingRequestId
        })
        void window.api.sessionUpdate({ sessionId: runSessionId, metadata }).then((updated) => {
          if (updated) dispatch(upsertSession(updated))
        })
      }

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
        dispatch(setChatStatus({ status: 'completed', requestId: null, sessionId: runSessionId }))
        finishSessionRun(runSessionId, requestId)
        message.info(CHAT_CANCELLED_MESSAGE)
        scrollBottom()
        return
      }

      const assistantId = crypto.randomUUID()
      const findAssistantRow = () =>
        getLiveMessages(runSessionId)?.find((m) => m.id === assistantId) ??
        store.getState().chat.messages.find((m) => m.id === assistantId)
      const assistantMsg: Message = {
        id: assistantId,
        sessionId: runSessionId,
        role: 'assistant',
        content: '',
        timestamp: skillHintTimestamp != null ? skillHintTimestamp + 1 : Date.now(),
        skillHints:
          routeSkillHintText && skillHintTimestamp != null
            ? [createSkillHintRecord(routeSkillHintText, skillHintTimestamp)]
            : undefined,
        status: 'streaming',
        schemaVersion: CURRENT_SCHEMA_VERSION
      }
      routeAddMessage(runSessionId, assistantMsg)
      initLiveSessionFromStore(runSessionId)
      await window.api.chatAppendMessage(assistantMsg)
      stickToBottomRef.current = true
      scrollBottom(true)

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
          applyAssistantPatch: (patch) => routePatchMessage(runSessionId, assistantId, patch),
          onDependencyRecovery: (recovery) => {
            void activateBrowserRecoverySkillIfNeeded({
              dependencyRecovery: recovery,
              sessionId: runSessionId,
              currentSkillsState: store.getState().session.list.find((x) => x.id === runSessionId)?.skillsState
            }).then((result) => {
              if (!result.activated || !result.hint) return
              lastSkillRouteSignatureRef.current = `${BROWSER_SETUP_RECOVERY_SKILL}@manual`
              const shownAt = Date.now()
              const row = findAssistantRow()
              const skillHints = appendSkillHintRecord(row?.skillHints, result.hint, shownAt)
              routePatchMessage(runSessionId, assistantId, { skillHints })
              void window.api.chatPatchMessage({
                messageId: assistantId,
                sessionId: runSessionId,
                patch: { skillHints }
              })
              scrollBottomThrottled()
              void window.api.sessionGet(runSessionId).then((s) => {
                if (s) dispatch(upsertSession(s))
              })
            })
          },
          onFileAutoApproved: () => {
            // 自动审批写入后不弹 toast，WriteSuccessCard 已展示 diff 信息
          }
        })
        controller.subscribe()
        registerToolChatController(requestId, controller)

        const unsubs: Array<() => void> = []
        const cleanup = () => {
          unregisterToolChatController(requestId)
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
          const payload = buildToolChatPayload({
            requestId,
            sessionId: runSessionId,
            model: requestModel,
            baseUrl: requestBaseUrl,
            llmServiceId: requestLlmServiceId,
            messages: historyForApi,
            currentUserMessageId,
            toolsConfig: cfg.tools,
            browserConfig: cfg.browser,
            shellConfig: cfg.shell,
            maxTokens: outputMaxTokens,
            thinkingEnabled: cfg.thinkingEnabled,
            system: systemPrompt || undefined,
            locale: resolveChatLocale(),
            effectiveModelForUsage
          })
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
            if (res.usage) {
              applyContextUsageUpdate(runSessionId, res.usage as NonNullable<LastUsage>)
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
            message.error(formatUserFacingError(res.error))
            return
          }
          const reconciled = reconcileAssistantStreamOnComplete({
            stopReason: res.stopReason,
            apiContent: res.content as unknown[],
            contentState,
            thinkingState
          })
          contentState = reconciled.contentState
          thinkingState = reconciled.thinkingState
          const textOut = reconciled.textOut
          flushStreamPersist(runSessionId, assistantId)
          flushUiPatch(runSessionId, assistantId)
          if (res.usage) {
            applyContextUsageUpdate(runSessionId, res.usage as NonNullable<LastUsage>)
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
          message.error(formatUserFacingError(err))
        } finally {
          cleanup()
        }
        return
      }

      const basePayload = buildClaudePayload(historyForApi)

      await runClaudeChatStream(
        {
          requestId,
          sessionId: runSessionId,
          model: requestModel,
          baseUrl: requestBaseUrl,
          messages: basePayload,
          system: systemPrompt || undefined,
          maxTokens: outputMaxTokens,
          locale: resolveChatLocale()
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
          onDone: async () => {
            const reconciled = reconcileAssistantStreamOnComplete({
              stopReason: 'end_turn',
              contentState,
              thinkingState
            })
            contentState = reconciled.contentState
            thinkingState = reconciled.thinkingState
            flushStreamPersist(runSessionId, assistantId)
            flushUiPatch(runSessionId, assistantId)
            const thinking = finalizeThinking(thinkingState)
            const contentSegments = finalizeContentSegments(contentState)
            routePatchMessage(runSessionId, assistantId, {
              content: reconciled.textOut,
              contentSegments,
              status: 'completed',
              thinking
            })
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId: runSessionId,
              patch: {
                content: reconciled.textOut,
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
            message.error(formatUserFacingError(err))
          }
        }
      )
    },
    [cfg, chatModelName, chatBaseUrl, chatLlmServiceId, currentSession, dispatch, sessionId, finishCancelled, message, persistSkillHintSystemMessage, t, tErrors, tContextUsage, useToolsApi]
  )

  sendInternalRef.current = sendInternal

  const send = useCallback(
    async (text: string, attachments?: ChatImageAttachment[]) => {
      if (!text.trim()) return

      const hasAttachments = (attachments?.length ?? 0) > 0
      if (hasAttachments && !useToolsApi) {
        message.error(tErrors('chat.imagesRequireTools'))
        return
      }

      let targetSessionId = sessionId
      if (!targetSessionId) {
        if (!cfg) {
          message.warning(t('chatView.warnings.selectSession'))
          return
        }
        try {
          const newSession = await window.api.sessionCreate({
            model: chatModelName,
            temperature: DEFAULT_LLM_TEMPERATURE,
            ...(chatLlmServiceId ? { llmServiceId: chatLlmServiceId } : {}),
            name: '',
            metadata: {}
          })
          dispatch(upsertSession(newSession))
          dispatch(setSession(newSession.id))
          targetSessionId = newSession.id
        } catch (e) {
          message.error(formatUserFacingError(e instanceof Error ? e.message : String(e)))
          return
        }
      }

      if (isSessionRunning(targetSessionId)) {
        const runSession =
          store.getState().session.list.find((x) => x.id === targetSessionId) ??
          (currentSession?.id === targetSessionId ? currentSession : undefined)
        const sessionSkillsState = normalizeSessionSkillsState(
          runSession?.skillsState ?? DEFAULT_SESSION_SKILLS_STATE
        )
        const wikiConfig = cfg?.wiki ?? DEFAULT_WIKI_CONFIG
        const kind = await classifyOutboundMessage(text, { wikiConfig, sessionSkillsState })
        if (kind === 'immediate-command') {
          await sendInternal(text, sessionSkillsState, { targetSessionId, bypassRunningGuard: true })
          return
        }
        await enqueueChatMessage(targetSessionId, text, attachments)
        return
      }

      await sendInternal(text, undefined, { targetSessionId, attachments })
    },
    [sessionId, cfg, sendInternal, dispatch, message, t, tErrors, currentSession, enqueueChatMessage, useToolsApi]
  )

  const retryFailedAssistant = useCallback(
    async (assistantMessageId: string) => {
      const msgs = store.getState().chat.messages
      const idx = msgs.findIndex((m) => m.id === assistantMessageId)
      if (idx < 0) return
      const assistant = msgs[idx]
      if (assistant.role !== 'assistant' || assistant.status !== 'failed') return

      let userText = ''
      let userMsg: Message | undefined
      for (let i = idx - 1; i >= 0; i--) {
        const row = msgs[i]
        if (row.role === 'user' && row.content.trim()) {
          userText = row.content
          userMsg = row
          break
        }
      }
      if (!userText.trim()) {
        message.warning(t('chatView.warnings.retryNoUserMessage'))
        return
      }

      dispatch(setMessages(msgs.filter((m) => m.id !== assistantMessageId)))
      await sendInternal(userText, undefined, {
        skipUserMessage: true,
        attachments: userMsg?.attachments,
        currentUserMessageId: userMsg?.id
      })
    },
    [dispatch, message, sendInternal, t]
  )

  const launchIntentConsumedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!chatLaunchIntent || !sessionId || chatLaunchIntent.sessionId !== sessionId || !cfg) return
    const key = `${chatLaunchIntent.sessionId}:${chatLaunchIntent.initialUserMessage}`
    if (launchIntentConsumedRef.current === key) return
    launchIntentConsumedRef.current = key

    const consume = async () => {
      const skillsState = activateRecoverySkillInState(
        currentSession?.skillsState,
        chatLaunchIntent.skillName
      )
      const updated = await window.api.sessionUpdate({
        sessionId,
        skillsState,
        metadata: {
          ...(currentSession?.metadata ?? {}),
          chatLaunchSource: chatLaunchIntent.source,
          ...(chatLaunchIntent.metadata ?? {})
        }
      })
      if (updated) dispatch(upsertSession(updated))
      dispatch(clearChatLaunchIntent())
      await sendInternal(chatLaunchIntent.initialUserMessage, updated?.skillsState ?? skillsState)
    }
    void consume()
  }, [chatLaunchIntent, sessionId, cfg, currentSession, dispatch, sendInternal])

  const running = sessionRunning
  const queueCount = sessionId ? countQueuedUserMessages(messages, sessionId) : 0

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
        message.error(formatUserFacingError(e instanceof Error ? e.message : String(e)))
      })
    },
    [message, openFile, cfg?.wiki?.rootPath]
  )

  const pendingConfirmItems = usePendingConfirmSnapshot()
  const pendingWriteDirConfirm = usePendingWriteDirConfirmSnapshot(sessionId)
  const pendingArtifactDecision = usePendingArtifactDecisionSnapshot(sessionId)

  const writeDirChoiceDir = useMemo(() => {
    const v = currentSession?.metadata?.writeDirChoice
    if (v && typeof v === 'object' && v !== null && 'dir' in v) {
      const dir = (v as { dir: unknown }).dir
      if (typeof dir === 'string' && dir.trim()) return dir
    }
    return null
  }, [currentSession?.metadata])

  const showLegacyWriteDirUi = shouldShowLegacyWriteDirUi(
    cfg?.workspaceLayout?.enabled,
    currentSession?.metadata?.artifactManagementEnabled === true
  )

  const testPreviewToolsInteractive = useMemo(
    () =>
      cfg
        ? {
            requestId: 'test-cards-preview',
            confirmMode: cfg.tools.confirmMode,
            onToolConfirm: (_toolUseId: string, approved: boolean) => {
              message.info(approved ? '测试预览：已确认（无实际操作）' : '测试预览：已拒绝（无实际操作）')
            },
            onToolCancel: () => {
              message.info('测试预览：已取消（无实际操作）')
            }
          }
        : undefined,
    [cfg, message]
  )

  const resolveToolsInteractive = useCallback(
    (messageId: string) => {
      if (testPreviewMessageIds.has(messageId)) return testPreviewToolsInteractive
      if (!sessionId || !cfg?.tools.enabled) return undefined
      const message = messages.find((m) => m.id === messageId)
      if (!message) return undefined
      return resolveMessageToolsInteractive({
        message,
        sessionId,
        toolsEnabled: cfg.tools.enabled,
        confirmMode: cfg.tools.confirmMode,
        pendingItems: pendingConfirmItems,
        streamingAssistantId,
        streamingRequestId,
        onToolConfirm,
        onToolCancel
      })
    },
    [
      sessionId,
      cfg?.tools.enabled,
      cfg?.tools.confirmMode,
      messages,
      pendingConfirmItems,
      streamingAssistantId,
      streamingRequestId,
      testPreviewMessageIds,
      testPreviewToolsInteractive,
      onToolConfirm,
      onToolCancel
    ]
  )

  const handleModelSelect = useCallback(
    async (opt: ChatModelOption) => {
      if (!sessionId) return
      const updated = await window.api.sessionUpdate({
        sessionId,
        model: opt.modelName,
        llmServiceId: opt.serviceId
      })
      if (updated) dispatch(upsertSession(updated))
    },
    [sessionId, dispatch]
  )

  const scrollToLatestLabel = t('scrollToLatest.label')

  return (
    <div className="chat-view">
      <div className="chat-scroll-wrap">
        <div ref={scrollRef} className="chat-scroll">
        {!sessionId ? (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden>
              <MessagesSquare size={22} strokeWidth={1.75} />
            </div>
            <div className="chat-empty-title">{t('chatView.empty.noSessionTitle')}</div>
            <p className="chat-empty-desc">{t('chatView.empty.noSessionDesc')}</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden>
              <MessageSquare size={22} strokeWidth={1.75} />
            </div>
            <div className="chat-empty-title">{t('chatView.empty.startTitle')}</div>
            <p className="chat-empty-desc">{t('chatView.empty.startDesc')}</p>
          </div>
        ) : (
          <ChatMessageListSearch messageCount={messages.length}>
            {messages.map((m) => (
              <ChatBubble
                key={m.id}
                message={m}
                enter={m.id === enterMessageId}
                toolsInteractive={resolveToolsInteractive(m.id)}
                focusToolUseId={
                  confirmFocusToolUseId &&
                  m.toolCalls?.some((tc) => tc.id === confirmFocusToolUseId && tc.status === 'confirming')
                    ? confirmFocusToolUseId
                    : undefined
                }
                workDir={cfg?.workDir}
                shellConfig={cfg?.shell}
                sessionMetadata={currentSession?.metadata}
                onOpenFile={handleOpenFile}
                wikiRootPath={cfg?.wiki?.rootPath ?? 'llm-wiki'}
                showArchiveToWiki={Boolean(cfg?.wiki?.enabled && m.role === 'assistant' && m.status === 'completed' && m.content.trim())}
                onArchiveToWiki={() => handleArchiveToWiki(m.content)}
                onRetry={
                  m.role === 'assistant' && m.status === 'failed' && !running
                    ? () => void retryFailedAssistant(m.id)
                    : undefined
                }
                onCancelQueued={
                  m.role === 'user' && m.status === 'queued'
                    ? () => void cancelQueuedMessage(m.id)
                    : undefined
                }
              />
            ))}
          </ChatMessageListSearch>
        )}
        </div>
        {sessionId && messages.length > 0 ? (
          <button
            type="button"
            className={`chat-scroll-to-latest${showScrollToLatest ? '' : ' chat-scroll-to-latest--hidden'}`}
            title={scrollToLatestLabel}
            aria-label={scrollToLatestLabel}
            aria-hidden={!showScrollToLatest}
            tabIndex={showScrollToLatest ? 0 : -1}
            onClick={handleScrollToLatest}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              handleScrollToLatest()
            }}
            dangerouslySetInnerHTML={{ __html: scrollToLatestIconSvg }}
          />
        ) : null}
      </div>
      {showLegacyWriteDirUi && pendingWriteDirConfirm ? (
        <div className="chat-write-dir-confirm">
          <div className="chat-write-dir-confirm__track">
            <WriteDirConfirmPanel
              requestId={pendingWriteDirConfirm.requestId}
              sessionId={pendingWriteDirConfirm.sessionId}
              candidates={pendingWriteDirConfirm.candidates}
              onRespond={(choice) => pendingWriteDirConfirmStore.respond(pendingWriteDirConfirm, choice)}
            />
          </div>
        </div>
      ) : null}
      {pendingArtifactDecision ? (
        <div className="chat-artifact-decision">
          <div className="chat-artifact-decision__track">
            <ArtifactDecisionCard
              request={pendingArtifactDecision}
              onRespond={(choice) => pendingArtifactDecisionStore.respond(pendingArtifactDecision, choice)}
              onCancel={() => pendingArtifactDecisionStore.cancel(pendingArtifactDecision)}
            />
          </div>
        </div>
      ) : null}
      {showLegacyWriteDirUi && writeDirChoiceDir ? (
        <div className="chat-write-dir-chip">
          <Tag>{t('writeDirChip.label', { dir: writeDirChoiceDir })}</Tag>
        </div>
      ) : null}
      <MessageInput
        ref={composerRef}
        sessionId={sessionId ?? undefined}
        historyMessages={composerHistoryMessages}
        toolsEnabled={useToolsApi}
        running={running}
        queueCount={queueCount}
        runningStatus={runningActivity?.label}
        runningDetail={runningActivity?.detail}
        runningElapsed={
          runningActivity?.showElapsed && streamingAssistant
            ? formatStreamingElapsed(runningClock - streamingAssistant.timestamp)
            : undefined
        }
        modelSlot={
          cfg ? (
            <ComposerModelPicker
              cfg={cfg}
              displayName={sessionBinding?.displayName ?? chatModelName}
              unavailable={Boolean(sessionBinding && !sessionBinding.option)}
              onSelect={(opt) => void handleModelSelect(opt)}
            />
          ) : null
        }
        onSend={send}
        onAbort={abort}
      />
    </div>
  )
}
