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
import { buildSystemPromptFromSkills, formatSkillRouteHint, truncateSystemPrompt } from '../../../shared/skillPrompt'
import type { Message, SkillActivationSource, SkillRouteRecentMessage } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE, DEFAULT_WIKI_CONFIG, normalizeSessionSkillsState } from '../../../shared/domainTypes'
import { resolveEffectiveOutputMaxTokens } from '../../../shared/llm/outputMaxTokens'
import { useDetailPanel } from '../DetailPanel/DetailPanelContext'
import { ChatBubble } from './ChatBubble'
import { MessageInput, type MessageInputHandle } from './MessageInput'
import type { SkillHint } from './SkillHintBubble'
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<MessageInputHandle>(null)
  const abortRequestedRef = useRef(false)
  const [skillHints, setSkillHints] = useState<SkillHint[]>([])

  const streamingAssistantId = useMemo(
    () => messages.find((m) => m.role === 'assistant' && m.status === 'streaming')?.id,
    [messages]
  )

  useEffect(() => {
    setSkillHints([])
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

  const sessionRunning = Boolean(sessionId && runningSessions[sessionId])

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
    async (text: string) => {
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
        setSkillHints((prev) => [...prev, { text: wikiCmd.hint, timestamp: Date.now() }])
        scrollBottom()
        if (wikiCmd.skillsState) {
          const updated = await window.api.sessionUpdate({ sessionId, skillsState: wikiCmd.skillsState })
          if (updated) dispatch(upsertSession(updated))
        }
        return
      }
      if (wikiCmd.type === 'run') {
        setSkillHints((prev) => [...prev, { text: wikiCmd.hint, timestamp: Date.now() }])
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
        setSkillHints((prev) => [...prev, { text: cmd.hint, timestamp: Date.now() }])
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
      if (activeSkills.length > 0) {
        setSkillHints((prev) => [...prev, { text: formatSkillRouteHint(activeSkills, routeResult.meta.sources), timestamp: Date.now() }])
        scrollBottom()
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
          const payload = buildToolChatPayload({
            requestId,
            sessionId: runSessionId,
            model: cfg.model,
            baseUrl: cfg.baseUrl || undefined,
            messages: historyForApi,
            toolsConfig: cfg.tools,
            browserConfig: cfg.browser,
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
    [cfg, currentSession, dispatch, sessionId, finishCancelled, message]
  )

  const send = useCallback(
    async (text: string) => {
      await sendInternal(text)
    },
    [sendInternal]
  )

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

  const timeline = useMemo(() => {
    const items: Array<
      | { kind: 'message'; message: Message; timestamp: number }
      | { kind: 'hint'; hint: SkillHint; timestamp: number }
    > = [
      ...messages.map((m) => ({ kind: 'message' as const, message: m, timestamp: m.timestamp })),
      ...skillHints.map((h) => ({ kind: 'hint' as const, hint: h, timestamp: h.timestamp }))
    ]
    items.sort((a, b) => a.timestamp - b.timestamp)
    return items
  }, [messages, skillHints])

  return (
    <div className="chat-view">
      <div ref={scrollRef} className="chat-scroll">
        {!sessionId ? (
          <div className="chat-empty">
            <div className="chat-empty-title">选择或创建一个会话</div>
            <Text type="secondary">在左侧开始与 AI 助手对话</Text>
          </div>
        ) : timeline.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-title">开始对话</div>
            <Text type="secondary">输入问题，或尝试 /skill、/wiki 命令</Text>
          </div>
        ) : (
          timeline.map((item) => {
            if (item.kind === 'hint') {
              return (
                <div key={`hint-${item.hint.timestamp}`} className="chat-system-track">
                  <span className="chat-skill-hint">{item.hint.text}</span>
                </div>
              )
            }
            const m = item.message
            return (
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
            )
          })
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
