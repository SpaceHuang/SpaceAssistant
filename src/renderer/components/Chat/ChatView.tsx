import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App } from 'antd'
import { MessageSquare, MessagesSquare } from 'lucide-react'
import { useTypedSelector, useAppDispatch } from '../../hooks'
import {
  ackDisplayMessagePersisted,
  mergeTurnFailures,
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
  getLiveMessages,
  initLiveSessionFromStore,
  abortSessionRun,
  routeAddMessage,
} from '../../services/chatRunnerService'
import { ackApiContextMessagePersisted } from '../../services/apiContextService'
import {
  commitMessageDelete,
  commitMessagePatch,
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
import { upsertSession } from '../../store/sessionSlice'
import { store } from '../../store'
import { registerMessagesReloadHandler } from '../../services/invalidationService'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { resolveChatLocale } from '../../utils/resolveChatLocale'
import { buildToolChatPayload } from '../../services/chatToolSessionService'
import type { ToolConfirmOptions } from '../../../shared/toolConfirm'
import { ComposerModelPicker } from './ComposerModelPicker'
import { resolveSessionModelBinding, resolveSessionThinkingBinding } from '../../services/sessionModelBinding'
import type { AgentReasoningEffort } from '../../../shared/agent/invocation'
import { ComposerThinkingPicker } from './ComposerThinkingPicker'
import { resolveFailureReasonForMessage } from '../../services/turnFailureDisplay'
import { loadTurnFailureReasons } from '../../services/turnFailureHydration'
import type { ChatModelOption } from '../../../shared/llmModelConfig'
import { runTestCardsPreview } from '../../services/testCardsPreviewService'
import { appendArchivedQuery, patchSessionWikiState } from '../../services/wikiSessionState'
import { requestFilePaneSelect, isUnderWikiRoot } from '../../services/filePaneNavigation'
import { ensureWorkDirForSession } from '../../services/workDirSessionSync'
import { activateBrowserRecoverySkillIfNeeded } from '../../services/browserRecoverySkillService'
import { activateRecoverySkillInState, BROWSER_SETUP_RECOVERY_SKILL } from '../../../shared/browserDependencyRecovery'
import { clearChatLaunchIntent } from '../../store/chatLaunchSlice'
import { filterBuiltinToolsForRenderer } from '../../../shared/toolsConfigFilter'
import { getCachedToolExposure, subscribeToolExposure } from '../../services/toolExposureService'
import { appendSkillHintRecord, createSkillHintRecord, createSkillHintSystemMessage } from '../../../shared/skillHintRecords'
import type { ChatImageAttachment, Message } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_LLM_TEMPERATURE, DEFAULT_SESSION_SKILLS_STATE, DEFAULT_WIKI_CONFIG, normalizeSessionSkillsState, type SessionSkillsState } from '../../../shared/domainTypes'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import { ChatMessageList } from './ChatMessageList'
import { CompactionMarker } from './CompactionMarker'
import type { ChatMessageActions } from './ChatMessageActions'
import { ChatMessageViewport, type ChatMessageViewportHandle } from './ChatMessageViewport'
import { ChatRunningElapsed, resolveChatRunningLabels } from './ChatRunningStatus'
import { MessageInput, type MessageInputHandle } from './MessageInput'
import { CHAT_CANCELLED_MESSAGE } from '../../../shared/chatCancel'
import { throttle } from '../../utils/throttle'
import arrowDownLineRaw from '../../assets/arrow_down_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'

const scrollToLatestIconSvg = patchSvg(arrowDownLineRaw, 16)
import { useChatMessageEnter } from '../../hooks/useChatMessageEnter'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { countQueuedUserMessages, filterMessagesForChatApi } from '../../../shared/chatMessageQueue'
import type { OutboundContextIntent } from '../../../shared/outboundProtocol'
import { ChatMessageListSearch } from '../Search/ChatMessageListSearch'

type SendInternalOptions = {
  targetSessionId?: string
  /** 显式发送上下文意图；缺省为 create-user。决定（排队/发起/拒绝）由主进程受理端口做出 */
  contextIntent?: OutboundContextIntent
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
  const compactionMarkers = useTypedSelector((s) => s.chat.compactionMarkers)
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
  const turnFailures = useTypedSelector((s) => s.chat.turnFailures)
  const cfg = useTypedSelector((s) => s.config.config)
  const currentSession = useTypedSelector((s) => s.session.list.find((x) => x.id === s.chat.currentSessionId))
  const [draftModelOption, setDraftModelOption] = useState<ChatModelOption | undefined>(undefined)
  const [draftThinkingEffort, setDraftThinkingEffort] = useState<AgentReasoningEffort | undefined>(undefined)
  const sessionBinding = useMemo(
    () => (cfg ? resolveSessionModelBinding(cfg, currentSession, draftModelOption) : null),
    [cfg, currentSession, draftModelOption]
  )
  // 会话级 Thinking 强度（§4.2 两层解析）：会话覆盖 > composer 草稿 > 全局默认
  const thinkingBinding = useMemo(
    () => (cfg ? resolveSessionThinkingBinding(cfg, currentSession, draftThinkingEffort) : null),
    [cfg, currentSession, draftThinkingEffort]
  )
  // 评审 N6：草稿只服务「composer 先于首个会话」的窗口；一旦存在会话（含侧边栏新建）即清除，
  // 防止草稿在回到无会话状态时「复活」并被带入无关会话（draftModelOption 同款沿袭缺陷一并修复）
  const currentSessionId = currentSession?.id
  useEffect(() => {
    if (currentSessionId) {
      setDraftThinkingEffort(undefined)
      setDraftModelOption(undefined)
    }
  }, [currentSessionId])
  const chatModelName = sessionBinding?.modelName ?? cfg?.model ?? ''
  const chatLlmServiceId = sessionBinding?.llmServiceId
  const currentModelEntry = useMemo(
    () => (cfg && chatModelName ? cfg.models.find((m) => m.name === chatModelName) : undefined),
    [cfg, chatModelName]
  )
  const chatBaseUrl = useMemo(() => {
    if (!cfg) return undefined
    const svc = cfg.llmServices.find((s) => s.id === chatLlmServiceId)
    return svc?.baseUrl || cfg.baseUrl || undefined
  }, [cfg, chatLlmServiceId])
  // exposure 清单由主进程下发；空窗（null）内不启用工具（避免清单闪空，§5.2 启动时序定稿）
  const [exposureTools, setExposureTools] = useState<string[] | null>(() => getCachedToolExposure())
  useEffect(() => subscribeToolExposure(setExposureTools), [])
  // 工具能力由主进程按请求计算；该状态仅用于界面显示。
  const chatLaunchIntent = useTypedSelector((s) => s.chatLaunch.intent)
  const viewportRef = useRef<ChatMessageViewportHandle>(null)
  const stickToBottomRef = useRef(true)
  const composerRef = useRef<MessageInputHandle>(null)
  const abortRequestedRef = useRef(false)
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

  /**
   * 消息页统一入口：终态失败原因只存在主进程 turn 记录里，重开页面/切换会话拿不到 projection 事实，
   * 所以每次拉页都按 assistantMessageId 回查一次，历史失败气泡才不会只剩通用提示。
   * 回溯按 messageId 归并，晚到的结果也不会串到别的会话。
   */
  const fetchMessagePage = useCallback(
    async (payload: { sessionId: string; beforeSequence?: number; limit?: number }) => {
      const page = await window.api.chatGetMessagePage(payload)
      const reasons = await loadTurnFailureReasons(page.entries.map((entry) => entry.message))
      if (Object.keys(reasons).length > 0) dispatch(mergeTurnFailures(reasons))
      return page
    },
    [dispatch]
  )

  useEffect(() => {
    if (!sessionId) {
      dispatch(setMessages([]))
      return
    }
    let cancelled = false
    const generation = beginContextSummarySession(sessionId)
    void (async () => {
      const page = await fetchMessagePage({ sessionId, limit: 60 })
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
  }, [sessionId, dispatch, bumpContextSummary, fetchMessagePage])

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
      fetchPage: (payload) => fetchMessagePage(payload),
      setLoading: (loading) => dispatch(setLoadingBefore(loading)),
      prepend: (payload) => dispatch(prependDisplayPage(payload))
    })
  }, [sessionId, dispatch, fetchMessagePage])

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
      const page = await fetchMessagePage({ sessionId: targetSessionId, limit: 60 })
      dispatch(
        setDisplayPage({
          entries: page.entries,
          oldestSequence: page.oldestSequence,
          hasMoreBefore: page.hasMoreBefore,
          generation
        })
      )
    },
    [dispatch, fetchMessagePage]
  )

  // 偏差 11:入站消息等 Storage 变更统一由失效通知驱动重取(主进程广播 session:<id>:messages);
  // 渲染端只注册当前重载通道,不再各自直连订阅。会话元数据刷新保留(轻量、乐观路径)。
  useEffect(() => {
    const refreshSessionMeta = (targetSessionId: string) => {
      void window.api.sessionGet(targetSessionId).then((s) => {
        if (s) dispatch(upsertSession(s))
      })
    }
    registerMessagesReloadHandler((targetSessionId) => {
      refreshSessionMeta(targetSessionId)
      void reloadSessionMessagesFromDb(targetSessionId)
    })
    return () => {
      registerMessagesReloadHandler(null)
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
    const turnId = sessionId ? runningSessions[sessionId]?.turnId : undefined
    if (turnId) void window.api.chatCancelTurn(turnId)
  }, [runningSessions, sessionId])

  const { t: tChat } = useTypedTranslation('chat')

  const persistSkillHintSystemMessage = useCallback(
    async (targetSessionId: string, text: string, shownAt = Date.now()) => {
      const msg = createSkillHintSystemMessage(targetSessionId, text, shownAt)
      routeAddMessage(targetSessionId, msg)
      await window.api.messageAppendNonTurn(msg)
      scrollBottom(true)
    },
    [dispatch, scrollBottom]
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


  const showSkillHint = useCallback(
    (targetSessionId: string, hint: string, persisted?: { messageId: string; sequence: number }) => {
      if (!persisted) {
        // 无会话快路径：仅展示（主进程同样未落库）
        message.info(hint)
        return
      }
      // 主进程已落库的提示消息：用落库凭据本地路由真实 id（幂等归并，不重复 append）
      const local = createSkillHintSystemMessage(targetSessionId, hint)
      routeAddMessage(targetSessionId, { ...local, id: persisted.messageId })
      dispatch(ackDisplayMessagePersisted({ messageId: persisted.messageId, sequence: persisted.sequence }))
      scrollBottom(true)
    },
    [dispatch, message, scrollBottom]
  )

  // 出站提交（Phase 1c）：渲染端只表达意图；发起/排队/本地命令/守卫决定全部在主进程受理端口（偏差 9）。
  // 协议注释：turn 投影（chatOnTurnProjection）是唯一事实源；submitOutbound 返回载荷仅供即时展示，
  // 渲染端按 turnId/messageId 幂等归并，不得据此双写状态（投影事件可能先于 invoke 返回到达）。
  const submitOutbound = useCallback(
    async (text: string, skillsStateOverride?: SessionSkillsState, options?: SendInternalOptions) => {
      void skillsStateOverride
      const runSessionId = options?.targetSessionId ?? sessionId
      let result: Awaited<ReturnType<typeof window.api.chatSubmitOutbound>>
      try {
        result = await window.api.chatSubmitOutbound({
          ...(runSessionId ? { sessionId: runSessionId } : {}),
          text,
          ...(options?.contextIntent ? { contextIntent: options.contextIntent } : {})
        })
      } catch (err) {
        message.error(formatUserFacingError(err instanceof Error ? err.message : String(err)))
        return
      }

      if ('rejected' in result) {
        for (const w of result.rejected.warnings ?? []) message.warning(formatUserFacingError(w))
        message.error(formatUserFacingError(result.rejected.reason))
        return
      }

      if (result.accepted === 'local-command') {
        const cmd = result.command
        if (cmd.kind === 'test-pop-run') {
          await window.api.testPopShow()
          message.info('浮动通知已弹出（测试数据），点击通知或手动关闭 ✕ 按钮关闭。')
          return
        }
        if (cmd.kind === 'test-cards-run') {
          if (!runSessionId) return
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
        showSkillHint(
          runSessionId!,
          cmd.hint,
          cmd.messageId ? { messageId: cmd.messageId, sequence: cmd.sequence ?? 0 } : undefined
        )
        return
      }

      if (result.accepted === 'queued') {
        stickToBottomRef.current = true
        dispatch(ackDisplayMessagePersisted({ messageId: result.queued.messageId, sequence: result.queued.sequence }))
        scrollBottom(true)
        return
      }

      // turn-started：建立即时展示状态；后续事实流由投影驱动
      const { sessionId: sid, turnId, assistantMessage, warnings } = result
      for (const w of warnings ?? []) message.warning(formatUserFacingError(w))
      // 主进程代建会话（渲染端无会话发送）→ 切换当前会话视图
      if (sid !== sessionId) dispatch(setSession(sid))
      bumpContextSummary()
      stickToBottomRef.current = true
      dispatch(setChatStatus({ status: 'streaming', requestId: null, sessionId: sid, turnId }))
      routeAddMessage(sid, assistantMessage)
      initLiveSessionFromStore(sid)
      const sequence = await window.api.chatGetMessageSequence({ sessionId: sid, messageId: assistantMessage.id })
      if (sequence != null) {
        ackApiContextMessagePersisted({ messageId: assistantMessage.id, sequence }, sid)
        dispatch(ackDisplayMessagePersisted({ messageId: assistantMessage.id, sequence }))
      }
      scrollBottom(true)
    },
    [sessionId, dispatch, message, showSkillHint, persistSkillHintSystemMessage, bumpContextSummary]
  )

  sendInternalRef.current = submitOutbound

  const send = useCallback(
    async (text: string, attachments?: ChatImageAttachment[]) => {
      if (!text.trim()) return
      // 无会话 → 主进程创建（附带 composer 草稿偏好，B2）；运行中 → 主进程分类立即命令/排队；决定全部回主进程（偏差 9）
      const result = await submitOutbound(text, undefined, {
        targetSessionId: sessionId ?? undefined,
        contextIntent: { kind: 'create-user', text, attachments },
        ...(sessionId
          ? {}
          : {
              sessionPrefs: {
                model: chatModelName,
                ...(chatLlmServiceId ? { llmServiceId: chatLlmServiceId } : {}),
                ...(draftThinkingEffort ? { thinkingEffort: draftThinkingEffort } : {})
              }
            })
      })
      // §5.2 草稿保持:档位随主进程代建的首个会话落库后即清理
      if (result && result.accepted === 'turn-started' && result.sessionId !== sessionId) {
        setDraftThinkingEffort(undefined)
      }
    },
    [sessionId, submitOutbound, chatModelName, chatLlmServiceId, draftThinkingEffort]
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
      await submitOutbound(target.currentUser.message.content, undefined, {
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
    [dispatch, message, submitOutbound, t, sessionId]
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
      await submitOutbound(chatLaunchIntent.initialUserMessage, updated?.skillsState ?? skillsState)
    }
    void consume()
  }, [chatLaunchIntent, sessionId, cfg, currentSession, dispatch, submitOutbound])

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

  // 按 sessionId 预分组的确认就绪映射：同一份 pendingConfirmItems 下引用稳定，
  // 使各行 ChatBubble 的 memo 浅比较生效（J-03）。值原样透传三态：
  // undefined（未知/旧路径）/ false（未就绪）/ true（就绪），
  // 下游 ToolCallCard 门禁为 confirmationReady !== false，禁止把 undefined 归一为 false。
  const confirmationReadyBySession = useMemo(() => {
    const map: Record<string, Record<string, boolean | undefined>> = {}
    for (const item of pendingConfirmItems) {
      const byTool = (map[item.sessionId] ??= {})
      byTool[item.toolUseId] = item.confirmationReady
    }
    return map
  }, [pendingConfirmItems])

  const testPreviewToolsInteractive = useMemo(
    () =>
      cfg
        ? {
            requestId: 'test-cards-preview',
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
        pendingItems: pendingConfirmItems,
        streamingAssistantId,
        streamingRequestId
      })
    },
    [
      sessionId,
      cfg?.tools.enabled,
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
      if (!sessionId) {
        setDraftModelOption(opt)
        return
      }
      const updated = await window.api.sessionUpdate({
        sessionId,
        model: opt.modelName,
        llmServiceId: opt.serviceId
      })
      if (updated) dispatch(upsertSession(updated))
    },
    [sessionId, dispatch]
  )

  /** §5.2：会话级强度选择；null = 清除覆盖（回到继承全局）。无会话时保留为草稿，随创建写入。 */
  const handleThinkingSelect = useCallback(
    async (effort: AgentReasoningEffort | null) => {
      if (!sessionId) {
        setDraftThinkingEffort(effort ?? undefined)
        return
      }
      try {
        const updated = await window.api.sessionUpdate({ sessionId, thinkingEffort: effort })
        if (updated) dispatch(upsertSession(updated))
      } catch (e) {
        message.error(formatUserFacingError(e instanceof Error ? e.message : String(e)))
      }
    },
    [sessionId, dispatch, message]
  )

  const scrollToLatestLabel = t('scrollToLatest.label')

  const resolveFailureReason = useCallback(
    (m: Message) => resolveFailureReasonForMessage(turnFailures, m),
    [turnFailures]
  )

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
        turnId={sessionId && streamingAssistant?.id === m.id ? runningSessions[sessionId]?.turnId : undefined}
        enterMessageId={enterMessageId}
        actions={messageActions}
        confirmationReadyBySession={confirmationReadyBySession}
        resolveToolsInteractive={resolveToolsInteractive}
        showArchiveToWiki={showArchiveToWikiFor}
        canRetry={canRetryMessage}
        canCancelQueued={canCancelQueuedMessage}
        resolveFailureReason={resolveFailureReason}
        focusToolUseId={confirmFocusToolUseId}
        pendingConfirmItems={pendingConfirmItems}
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
      confirmationReadyBySession,
      resolveToolsInteractive,
      showArchiveToWikiFor,
      canRetryMessage,
      canCancelQueuedMessage,
      resolveFailureReason,
      confirmFocusToolUseId,
      sessionId,
      runningSessions,
      pendingConfirmItems,
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
      {compactionMarkers.length > 0 ? <CompactionMarker count={compactionMarkers.length} /> : null}
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
      <MessageInput
        ref={composerRef}
        sessionId={sessionId ?? undefined}
        historyImageTokens={contextScalars.historyImageTokens}
        thinkingTokensToExclude={contextScalars.thinkingTokensToExclude}
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
        thinkingSlot={
          cfg && thinkingBinding ? (
            <ComposerThinkingPicker
              value={thinkingBinding.effort}
              overridden={thinkingBinding.overridden}
              globalEffort={thinkingBinding.globalEffort}
              disabled={currentModelEntry?.supportsThinking === false}
              disabledReason={currentModelEntry?.supportsThinking === false ? t('composer.thinking.notSupported') : undefined}
              onSelect={(effort) => void handleThinkingSelect(effort)}
            />
          ) : null
        }
        onSend={send}
        onAbort={abort}
      />
    </div>
  )
}
