import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App } from 'antd'
import { MessageSquare, MessagesSquare } from 'lucide-react'
import { useTypedSelector, useAppDispatch } from '../../hooks'
import { addMessage, setChatStatus, setConfirmFocusToolUseId, setLastUsage, setMessages, setScrollToMessageId } from '../../store/chatSlice'
import { openSettings } from '../../store/configSlice'
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
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import {
  buildToolChatPayload,
  createToolChatController,
  extractAssistantTextFromApiContent,
  type ToolChatController
} from '../../services/chatToolSessionService'
import { parseSkillCommand } from '../../services/skillCommandService'
import { parseTestCardsCommand } from '../../services/testCardsCommandService'
import { runTestCardsPreview } from '../../services/testCardsPreviewService'
import { parseWikiCommand } from '../../services/wikiCommandService'
import { appendWikiSchemaToSystemPrompt } from '../../services/wikiPrompt'
import { appendArchivedQuery, patchSessionWikiState } from '../../services/wikiSessionState'
import { requestFilePaneSelect, isUnderWikiRoot } from '../../services/filePaneNavigation'
import { appendSkillActivationLog } from '../../services/skillActivationLog'
import { activateBrowserRecoverySkillIfNeeded } from '../../services/browserRecoverySkillService'
import { activateRecoverySkillInState, BROWSER_SETUP_RECOVERY_SKILL } from '../../../shared/browserDependencyRecovery'
import { clearChatLaunchIntent } from '../../store/chatLaunchSlice'
import { filterBuiltinToolsForRenderer } from '../../../shared/toolsConfigFilter'
import { buildSystemPromptFromSkills, buildSkillRouteSignature, formatSkillRouteHint, truncateSystemPrompt } from '../../../shared/skillPrompt'
import { appendSkillHintRecord, createSkillHintRecord, createSkillHintSystemMessage } from '../../../shared/skillHintRecords'
import type { Message, SkillActivationSource, SkillRouteRecentMessage } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE, DEFAULT_WIKI_CONFIG, normalizeSessionSkillsState, type SessionSkillsState } from '../../../shared/domainTypes'
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
import { isChatScrollNearBottom, scrollChatToBottom } from '../../utils/chatScroll'
import { useChatMessageEnter } from '../../hooks/useChatMessageEnter'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type SendInternalOptions = {
  skipUserMessage?: boolean
}

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
  const { t } = useTypedTranslation('chat')
  const { openFile } = useDetailPanel()
  const dispatch = useAppDispatch()
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const messages = useTypedSelector((s) => s.chat.messages)
  const runningSessions = useTypedSelector((s) => s.chat.runningSessions)
  const confirmFocusToolUseId = useTypedSelector((s) => s.chat.confirmFocusToolUseId)
  const scrollToMessageId = useTypedSelector((s) => s.chat.scrollToMessageId)
  const cfg = useTypedSelector((s) => s.config.config)
  const currentSession = useTypedSelector((s) => s.session.list.find((x) => x.id === s.chat.currentSessionId))
  const chatLaunchIntent = useTypedSelector((s) => s.chatLaunch.intent)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const composerRef = useRef<MessageInputHandle>(null)
  const abortRequestedRef = useRef(false)
  const lastSkillRouteSignatureRef = useRef('')
  const [testPreviewMessageIds, setTestPreviewMessageIds] = useState<Set<string>>(() => new Set())

  const streamingAssistantId = useMemo(
    () => messages.find((m) => m.role === 'assistant' && m.status === 'streaming')?.id,
    [messages]
  )

  const messageIds = useMemo(() => messages.map((m) => m.id), [messages])
  const enterMessageId = useChatMessageEnter(sessionId, messageIds)

  useEffect(() => {
    lastSkillRouteSignatureRef.current = ''
    setTestPreviewMessageIds(new Set())
    stickToBottomRef.current = true
  }, [sessionId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickToBottomRef.current = isChatScrollNearBottom(el)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [sessionId])

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

  const toolChatControllerRef = useRef<ToolChatController | null>(null)

  const onToolConfirm = useCallback(
    (toolUseId: string, approved: boolean) => {
      const pending = sessionId ? pendingConfirmStore.find(sessionId, toolUseId) : undefined
      const requestId = pending?.requestId ?? streamingRequestId
      if (!requestId) return
      toolChatControllerRef.current?.applyConfirmOutcome(toolUseId, approved)
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
      scrollBottom(true)
    },
    [dispatch, message, scrollBottom]
  )

  const persistSkillHintSystemMessage = useCallback(
    async (targetSessionId: string, text: string, shownAt = Date.now()) => {
      const msg = createSkillHintSystemMessage(targetSessionId, text, shownAt)
      dispatch(addMessage(msg))
      await window.api.chatAppendMessage(msg)
      scrollBottom(true)
    },
    [dispatch, scrollBottom]
  )

  const sendInternal = useCallback(
    async (text: string, skillsStateOverride?: SessionSkillsState, options?: SendInternalOptions) => {
      if (!sessionId || !cfg) {
        message.warning(t('chatView.warnings.selectSession'))
        return
      }
      const runSessionId = sessionId
      if (isSessionRunning(runSessionId)) {
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
        skillsStateOverride ?? currentSession?.skillsState ?? DEFAULT_SESSION_SKILLS_STATE
      )
      let chatText = text
      let wikiModeRun = false

      const wikiCmd = await parseWikiCommand(text, wikiConfig, sessionSkillsState)
      if (wikiCmd.type === 'command') {
        await persistSkillHintSystemMessage(runSessionId, wikiCmd.hint)
        if (wikiCmd.skillsState) {
          const updated = await window.api.sessionUpdate({ sessionId, skillsState: wikiCmd.skillsState })
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
          sessionId,
          skillsState: wikiCmd.skillsState,
          metadata: patchSessionWikiState(currentSession?.metadata, { wikiModeActive: true })
        })
        if (updated) dispatch(upsertSession(updated))
      }

      const cmd = await parseSkillCommand(chatText, sessionSkillsState)
      if (cmd.type === 'command') {
        await persistSkillHintSystemMessage(runSessionId, cmd.hint)
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

      if (!options?.skipUserMessage) {
        dispatch(addMessage(userMsg))
        await window.api.chatAppendMessage(userMsg)
        stickToBottomRef.current = true
      }

      const requestId = crypto.randomUUID()
      registerSessionRun(runSessionId, requestId)
      abortRequestedRef.current = false
      dispatch(setChatStatus({ status: 'streaming', requestId, sessionId: runSessionId }))

      const historyForApi = [...store.getState().chat.messages]
      const useToolsApi =
        cfg.tools.enabled && filterBuiltinToolsForRenderer(cfg.tools, cfg.feishu, cfg.browser).length > 0

      const recentMessages: SkillRouteRecentMessage[] = historyForApi
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.status !== 'streaming' && m.content.trim())
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      const routeResult = await window.api.skillRoute({
        userInput: chatText,
        sessionSkillsState,
        sessionId: runSessionId,
        sessionMetadata: currentSession?.metadata,
        recentMessages,
        model: cfg.model
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
        const metadata = appendSkillActivationLog(currentSession?.metadata ?? {}, {
          skillNames: activeSkills.map((s) => s.meta.name),
          source: logSource,
          userInput: chatText,
          llmRecommended: routeResult.meta.llmRecommended,
          routingFailed: routeResult.meta.routingFailed,
          routingError: routeResult.meta.routingError,
          routingRequestId: routeResult.meta.routingRequestId
        })
        void window.api.sessionUpdate({ sessionId, metadata }).then((updated) => {
          if (updated) dispatch(upsertSession(updated))
        })
      }

      const modelEntry = cfg.models.find((m) => m.name === cfg.model)
      const outputMaxTokens = resolveEffectiveOutputMaxTokens(cfg.model, cfg.models)
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
      dispatch(addMessage(assistantMsg))
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
          }
        })
        controller.subscribe()
        toolChatControllerRef.current = controller

        const unsubs: Array<() => void> = []
        const cleanup = () => {
          toolChatControllerRef.current = null
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
            model: cfg.model,
            baseUrl: cfg.baseUrl || undefined,
            messages: historyForApi,
            toolsConfig: cfg.tools,
            browserConfig: cfg.browser,
            shellConfig: cfg.shell,
            maxTokens: outputMaxTokens,
            thinkingEnabled: cfg.thinkingEnabled,
            system: systemPrompt || undefined
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
            message.error(formatUserFacingError(err))
          }
        }
      )
    },
    [cfg, currentSession, dispatch, sessionId, finishCancelled, message, persistSkillHintSystemMessage, t]
  )

  const send = useCallback(
    async (text: string) => {
      await sendInternal(text)
    },
    [sendInternal]
  )

  const retryFailedAssistant = useCallback(
    async (assistantMessageId: string) => {
      const msgs = store.getState().chat.messages
      const idx = msgs.findIndex((m) => m.id === assistantMessageId)
      if (idx < 0) return
      const assistant = msgs[idx]
      if (assistant.role !== 'assistant' || assistant.status !== 'failed') return

      let userText = ''
      for (let i = idx - 1; i >= 0; i--) {
        const row = msgs[i]
        if (row.role === 'user' && row.content.trim()) {
          userText = row.content
          break
        }
      }
      if (!userText.trim()) {
        message.warning(t('chatView.warnings.retryNoUserMessage'))
        return
      }

      dispatch(setMessages(msgs.filter((m) => m.id !== assistantMessageId)))
      await sendInternal(userText, undefined, { skipUserMessage: true })
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

  const resolveToolsInteractive = useCallback(
    (messageId: string) => {
      if (messageId === streamingAssistantId) return toolsInteractive
      if (testPreviewMessageIds.has(messageId)) return testPreviewToolsInteractive
      return undefined
    },
    [streamingAssistantId, toolsInteractive, testPreviewMessageIds, testPreviewToolsInteractive]
  )

  return (
    <div className="chat-view">
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
          <div className="chat-message-list">
            {messages.map((m) => (
              <ChatBubble
                key={m.id}
                message={m}
                enter={m.id === enterMessageId}
                toolsInteractive={resolveToolsInteractive(m.id)}
                focusToolUseId={m.id === streamingAssistantId ? confirmFocusToolUseId : undefined}
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
              />
            ))}
          </div>
        )}
      </div>
      <MessageInput
        ref={composerRef}
        disabled={!sessionId}
        running={running}
        modelLabel={cfg?.model}
        onSend={send}
        onAbort={abort}
      />
    </div>
  )
}
