import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Tag } from 'antd'
import { MessageSquare, MessagesSquare } from 'lucide-react'
import { useTypedSelector, useAppDispatch } from '../../hooks'
import {
  ackDisplayMessagePersisted,
  prependDisplayPage,
  removeMessage,
  restoreLastUsage,
  setChatStatus,
  setConfirmFocusToolUseId,
  setDisplayPage,
  setLoadingBefore,
  setMessages,
  setScrollToMessageId,
  setSession
} from '../../store/chatSlice'
import { openSettings } from '../../store/configSlice'
import type { LastUsage } from '../../store/chatSlice'
import {
  clearLiveSession,
  countRunningSessions,
  finishSessionRun,
  flushStreamPersist,
  flushStreamPersistAndWait,
  flushUiPatch,
  getLiveMessages,
  getToolChatController,
  initLiveSessionFromStore,
  getMaxParallelChatSessions,
  abortSessionRun,
  registerSessionRun,
  registerToolChatController,
  routeAddMessage,
  routePatchMessage,
  routeStreamPatchMessage,
  isSessionRunning,
  unregisterToolChatController
} from '../../services/chatRunnerService'
import { resolveSessionContextForApi, ackApiContextMessagePersisted } from '../../services/apiContextService'
import {
  commitMessageDelete,
  commitMessagePatch,
  prepareSendContext,
  type SendContextIntent
} from '../../services/messageMutationGateway'
import {
  applyContextSummaryDbBaseline,
  beginContextSummarySession,
  selectContextSummaryScalars
} from '../../services/contextHistorySummaryService'
import {
  ensureDisplayContainsMessage,
  loadPreviousDisplayPage
} from '../../services/displayPageLoader'
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
import { ChatMessageList } from './ChatMessageList'
import type { ChatMessageActions } from './ChatMessageActions'
import { ChatMessageViewport, type ChatMessageViewportHandle } from './ChatMessageViewport'
import { ChatRunningElapsed, resolveChatRunningLabels } from './ChatRunningStatus'
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
import arrowDownLineRaw from '../../assets/arrow_down_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'

const scrollToLatestIconSvg = patchSvg(arrowDownLineRaw, 16)
import { useChatMessageEnter } from '../../hooks/useChatMessageEnter'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import {
  countQueuedUserMessages,
  filterMessagesForChatApi,
  MAX_CHAT_MESSAGE_QUEUE_SIZE
} from '../../../shared/chatMessageQueue'
import { classifyOutboundMessage } from '../../services/chatOutboundClassifier'
import { ChatMessageListSearch } from '../Search/ChatMessageListSearch'
import {
  requestNeedsVisionModel,
  resolveVisionRouteForImageSend
} from '../../../shared/visionModelRouting'

type SendInternalOptions = {
  targetSessionId?: string
  /** 会话执行中仍允许执行的即时命令（/skill list 等） */
  bypassRunningGuard?: boolean
  /** 显式发送上下文意图；缺省为 create-user */
  contextIntent?: SendContextIntent
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
  const displayEntries = useTypedSelector((s) => s.chat.displayEntries)
  const [contextSummaryTick, setContextSummaryTick] = useState(0)
  const contextScalars = useMemo(() => {
    void contextSummaryTick
    if (!sessionId) return { historyImageTokens: 0, thinkingTokensToExclude: 0 }
    return selectContextSummaryScalars(sessionId)
  }, [sessionId, contextSummaryTick, messages])
  const bumpContextSummary = useCallback(() => setContextSummaryTick((n) => n + 1), [])
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
  const viewportRef = useRef<ChatMessageViewportHandle>(null)
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

  const messageIds = useMemo(() => messages.map((m) => m.id), [messages])
  const enterMessageId = useChatMessageEnter(sessionId, messageIds)

  useEffect(() => {
    lastSkillRouteSignatureRef.current = ''
    setTestPreviewMessageIds(new Set())
    stickToBottomRef.current = true
    setShowScrollToLatest(false)
  }, [sessionId])

  const handleStickToBottomChange = useCallback((nearBottom: boolean) => {
    stickToBottomRef.current = nearBottom
    setShowScrollToLatest(!nearBottom)
  }, [])

  const handleScrollToLatest = useCallback(() => {
    stickToBottomRef.current = true
    setShowScrollToLatest(false)
    viewportRef.current?.scrollToBottom('smooth')
  }, [])

  useEffect(() => {
    if (!sessionId) {
      dispatch(setMessages([]))
      return
    }
    let cancelled = false
    const generation = beginContextSummarySession(sessionId)
    void (async () => {
      const page = await window.api.chatGetMessagePage({ sessionId, limit: 60 })
      if (cancelled) return
      dispatch(
        setDisplayPage({
          entries: page.entries,
          oldestSequence: page.oldestSequence,
          hasMoreBefore: page.hasMoreBefore,
          generation
        })
      )
      initLiveSessionFromStore(sessionId)
      try {
        const baseline = await window.api.chatGetContextHistorySummaryBaseline({ sessionId })
        if (cancelled) return
        applyContextSummaryDbBaseline(sessionId, generation, baseline.entries)
        bumpContextSummary()
      } catch {
        // 校准失败保留空 base + 后续 override
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, dispatch, bumpContextSummary])

  const loadPreviousPage = useCallback(async () => {
    if (!sessionId) return { loaded: false as const, beforeSequence: null as number | null }
    return loadPreviousDisplayPage({
      sessionId,
      getState: () => {
        const s = store.getState().chat
        return {
          currentSessionId: s.currentSessionId,
          hasMoreBefore: s.hasMoreBefore,
          oldestSequence: s.oldestSequence,
          loadingBefore: s.loadingBefore,
          displayGeneration: s.displayGeneration
        }
      },
      fetchPage: (payload) => window.api.chatGetMessagePage(payload),
      setLoading: (loading) => dispatch(setLoadingBefore(loading)),
      prepend: (payload) => dispatch(prependDisplayPage(payload))
    })
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
    if (!scrollToMessageId || !sessionId) return
    let cancelled = false
    void (async () => {
      if (!store.getState().chat.messages.some((m) => m.id === scrollToMessageId)) {
        const seq = await window.api.chatGetMessageSequence({
          sessionId,
          messageId: scrollToMessageId
        })
        if (seq == null || cancelled) {
          dispatch(setScrollToMessageId(null))
          return
        }
        await ensureDisplayContainsMessage({
          sessionId,
          messageId: scrollToMessageId,
          getMessages: () => store.getState().chat.messages,
          getState: () => {
            const s = store.getState().chat
            return {
              currentSessionId: s.currentSessionId,
              hasMoreBefore: s.hasMoreBefore,
              oldestSequence: s.oldestSequence,
              loadingBefore: s.loadingBefore,
              displayGeneration: s.displayGeneration
            }
          },
          loadPrevious: () => loadPreviousPage()
        })
      }
      if (cancelled) return
      viewportRef.current?.scrollToMessageId(scrollToMessageId)
      dispatch(setScrollToMessageId(null))
    })()
    return () => {
      cancelled = true
    }
  }, [scrollToMessageId, sessionId, dispatch, loadPreviousPage])

  const reloadSessionMessagesFromDb = useCallback(
    async (targetSessionId: string) => {
      if (store.getState().chat.currentSessionId !== targetSessionId) return
      const generation = store.getState().chat.displayGeneration + 1
      const page = await window.api.chatGetMessagePage({ sessionId: targetSessionId, limit: 60 })
      dispatch(
        setDisplayPage({
          entries: page.entries,
          oldestSequence: page.oldestSequence,
          hasMoreBefore: page.hasMoreBefore,
          generation
        })
      )
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

  const scrollRafRef = useRef<number | null>(null)

  const scrollBottom = useCallback((force = false) => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current)
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      if (!force && !stickToBottomRef.current) return
      viewportRef.current?.scrollToBottom(force ? 'smooth' : 'auto')
    })
  }, [])

  const scrollBottomThrottled = useMemo(
    () =>
      throttle((force = false) => {
        if (scrollRafRef.current !== null) {
          cancelAnimationFrame(scrollRafRef.current)
        }
        scrollRafRef.current = requestAnimationFrame(() => {
          scrollRafRef.current = null
          if (!force && !stickToBottomRef.current) return
          viewportRef.current?.scrollToBottom('auto')
        })
      }, 100),
    []
  )

  useEffect(() => {
    return () => {
      scrollBottomThrottled.cancel()
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [scrollBottomThrottled])

  useEffect(() => {
    scrollBottomThrottled.cancel()
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
  }, [sessionId, scrollBottomThrottled])

  const streamingRequestId = sessionId ? runningSessions[sessionId]?.requestId ?? null : null

  const sessionRunning = Boolean(sessionId && runningSessions[sessionId])

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
      const ack = await window.api.chatAppendMessage(userMsg)
      dispatch(ackDisplayMessagePersisted({ messageId: ack.messageId, sequence: ack.sequence }))
      scrollBottom(true)
    },
    [dispatch, message, scrollBottom, t]
  )

  const cancelQueuedMessage = useCallback(
    async (messageId: string) => {
      const msg = store.getState().chat.messages.find((m) => m.id === messageId)
      if (!msg || msg.role !== 'user' || msg.status !== 'queued') return
      try {
        await commitMessageDelete({ sessionId: msg.sessionId, messageId })
      } catch {
        message.warning(t('chatView.warnings.cancelQueueFailed'))
      }
    },
    [message, t]
  )

  const drainQueueForSession = useCallback(
    async (runSessionId: string) => {
      if (drainingQueueRef.current || isSessionRunning(runSessionId)) return

      const next = await window.api.chatGetNextQueuedMessage({ sessionId: runSessionId })
      if (!next || next.message.role !== 'user' || next.message.status !== 'queued') return

      drainingQueueRef.current = true
      try {
        const sent = await commitMessagePatch({
          sessionId: runSessionId,
          messageId: next.message.id,
          patch: { status: 'sent' }
        })
        await sendInternalRef.current(sent.message.content, undefined, {
          targetSessionId: runSessionId,
          contextIntent: {
            kind: 'reuse-user',
            currentUser: {
              message: sent.message,
              order: { kind: 'persisted', sequence: sent.sequence }
            }
          }
        })
      } finally {
        drainingQueueRef.current = false
      }
    },
    []
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

      const createUserAttachments =
        options?.contextIntent?.kind === 'create-user'
          ? options.contextIntent.attachments
          : undefined
      if ((createUserAttachments?.length ?? 0) > 0 && !useToolsApi) {
        message.error(tErrors('chat.imagesRequireTools'))
        return
      }

      const intent: SendContextIntent =
        options?.contextIntent ??
        ({
          kind: 'create-user',
          text: chatText,
          attachments: undefined
        } as const)

      // create-user 使用解析后的 chatText（可能被 skill/wiki 改写）
      const resolvedIntent: SendContextIntent =
        intent.kind === 'create-user'
          ? { kind: 'create-user', text: chatText, attachments: intent.attachments }
          : intent

      if (resolvedIntent.kind === 'create-user') {
        stickToBottomRef.current = true
      }

      let apiRequest
      try {
        apiRequest = await prepareSendContext(runSessionId, resolvedIntent)
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
        return
      }
      bumpContextSummary()

      let historyForApi: Message[]
      let currentUserMessageId: string
      try {
        const resolved = await resolveSessionContextForApi(apiRequest)
        historyForApi = resolved.historyForApi
        currentUserMessageId = resolved.requiredCurrentUserId
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err))
        return
      }

      const requiredUser = apiRequest.requiredCurrentUser.message

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
      const pendingAttachments =
        resolvedIntent.kind === 'create-user' ? requiredUser.attachments : undefined
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
      const assistantAck = await window.api.chatAppendMessage(assistantMsg)
      ackApiContextMessagePersisted(assistantAck, runSessionId)
      dispatch(ackDisplayMessagePersisted({ messageId: assistantAck.messageId, sequence: assistantAck.sequence }))
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

      await sendInternal(text, undefined, {
        targetSessionId,
        contextIntent: {
          kind: 'create-user',
          text,
          attachments
        }
      })
    },
    [sessionId, cfg, sendInternal, dispatch, message, t, tErrors, currentSession, enqueueChatMessage, useToolsApi]
  )

  const retryFailedAssistant = useCallback(
    async (assistantMessageId: string) => {
      if (!sessionId) return
      const target = await window.api.chatResolveRetryContext({
        sessionId,
        failedAssistantMessageId: assistantMessageId
      })
      if (!target) {
        message.warning(t('chatView.warnings.retryNoUserMessage'))
        return
      }

      dispatch(removeMessage(assistantMessageId))
      await sendInternal(target.currentUser.message.content, undefined, {
        contextIntent: {
          kind: 'reuse-user',
          currentUser: {
            message: target.currentUser.message,
            order: { kind: 'persisted', sequence: target.currentUser.sequence }
          },
          excludeMessageIds: [target.failedAssistant.message.id]
        }
      })
    },
    [dispatch, message, sendInternal, t, sessionId]
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

  const messageActions = useMemo<ChatMessageActions>(
    () => ({
      archiveToWiki: (content) => {
        void handleArchiveToWiki(content)
      },
      retryAssistant: (messageId) => {
        void retryFailedAssistant(messageId)
      },
      cancelQueued: (messageId) => {
        void cancelQueuedMessage(messageId)
      },
      confirmTool: onToolConfirm,
      cancelTool: onToolCancel
    }),
    [handleArchiveToWiki, retryFailedAssistant, cancelQueuedMessage, onToolConfirm, onToolCancel]
  )

  const resolveToolsInteractive = useCallback(
    (m: Message) => {
      if (testPreviewMessageIds.has(m.id)) return testPreviewToolsInteractive
      if (!sessionId || !cfg?.tools.enabled) return undefined
      return resolveMessageToolsInteractive({
        message: m,
        sessionId,
        toolsEnabled: cfg.tools.enabled,
        confirmMode: cfg.tools.confirmMode,
        pendingItems: pendingConfirmItems,
        streamingAssistantId,
        streamingRequestId
      })
    },
    [
      sessionId,
      cfg?.tools.enabled,
      cfg?.tools.confirmMode,
      pendingConfirmItems,
      streamingAssistantId,
      streamingRequestId,
      testPreviewMessageIds,
      testPreviewToolsInteractive
    ]
  )

  const showArchiveToWikiFor = useCallback(
    (m: Message) =>
      Boolean(cfg?.wiki?.enabled && m.role === 'assistant' && m.status === 'completed' && m.content.trim()),
    [cfg?.wiki?.enabled]
  )

  const canRetryMessage = useCallback(
    (m: Message) => m.role === 'assistant' && m.status === 'failed' && !running,
    [running]
  )

  const canCancelQueuedMessage = useCallback(
    (m: Message) => m.role === 'user' && m.status === 'queued',
    []
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

  const runningLabels = useMemo(
    () => resolveChatRunningLabels(streamingAssistant, t),
    [streamingAssistant, t]
  )

  const runningElapsedNode = streamingAssistant ? (
    <ChatRunningElapsed streamingAssistant={streamingAssistant} />
  ) : undefined

  const renderViewportMessage = useCallback(
    (_index: number, m: Message) => (
      <ChatMessageList
        messages={[m]}
        enterMessageId={enterMessageId}
        actions={messageActions}
        resolveToolsInteractive={resolveToolsInteractive}
        showArchiveToWiki={showArchiveToWikiFor}
        canRetry={canRetryMessage}
        canCancelQueued={canCancelQueuedMessage}
        focusToolUseId={confirmFocusToolUseId}
        workDir={cfg?.workDir}
        shellConfig={cfg?.shell}
        sessionMetadata={currentSession?.metadata}
        onOpenFile={handleOpenFile}
        wikiRootPath={cfg?.wiki?.rootPath ?? 'llm-wiki'}
      />
    ),
    [
      enterMessageId,
      messageActions,
      resolveToolsInteractive,
      showArchiveToWikiFor,
      canRetryMessage,
      canCancelQueuedMessage,
      confirmFocusToolUseId,
      cfg?.workDir,
      cfg?.shell,
      cfg?.wiki?.rootPath,
      currentSession?.metadata,
      handleOpenFile
    ]
  )

  const viewportBody = !sessionId ? (
    <div className="chat-scroll-wrap">
      <div className="chat-scroll">
        <div className="chat-empty">
          <div className="chat-empty-icon" aria-hidden>
            <MessagesSquare size={22} strokeWidth={1.75} />
          </div>
          <div className="chat-empty-title">{t('chatView.empty.noSessionTitle')}</div>
          <p className="chat-empty-desc">{t('chatView.empty.noSessionDesc')}</p>
        </div>
      </div>
    </div>
  ) : messages.length === 0 ? (
    <div className="chat-scroll-wrap">
      <div className="chat-scroll">
        <div className="chat-empty">
          <div className="chat-empty-icon" aria-hidden>
            <MessageSquare size={22} strokeWidth={1.75} />
          </div>
          <div className="chat-empty-title">{t('chatView.empty.startTitle')}</div>
          <p className="chat-empty-desc">{t('chatView.empty.startDesc')}</p>
        </div>
      </div>
    </div>
  ) : (
    <ChatMessageListSearch
      sessionId={sessionId}
      messages={messages}
      displayEntries={displayEntries}
    >
      <ChatMessageViewport
        ref={viewportRef}
        messages={messages}
        stickToBottom={stickToBottomRef.current}
        onStickToBottomChange={handleStickToBottomChange}
        onStartReached={() => {
          void loadPreviousPage()
        }}
        scrollToLatestMounted
        showScrollToLatest={showScrollToLatest}
        scrollToLatestLabel={scrollToLatestLabel}
        scrollToLatestIconHtml={scrollToLatestIconSvg}
        onScrollToLatest={handleScrollToLatest}
        renderMessage={renderViewportMessage}
      />
    </ChatMessageListSearch>
  )

  return (
    <div className="chat-view">
      {viewportBody}
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
              uiStatus={pendingArtifactDecision.uiStatus ?? 'active'}
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
        historyImageTokens={contextScalars.historyImageTokens}
        thinkingTokensToExclude={contextScalars.thinkingTokensToExclude}
        toolsEnabled={useToolsApi}
        running={running}
        queueCount={queueCount}
        runningStatus={runningLabels.label}
        runningDetail={runningLabels.detail}
        runningElapsed={runningElapsedNode}
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
