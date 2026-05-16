import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Typography } from 'antd'

const { Text } = Typography
import { useTypedSelector, useAppDispatch } from '../../hooks'
import { addMessage, patchMessage, setChatStatus, setMessages } from '../../store/chatSlice'
import { upsertSession } from '../../store/sessionSlice'
import { store } from '../../store'
import { runClaudeChatStream } from '../../services/chatStreamService'
import {
  buildToolChatPayload,
  createToolChatController,
  extractAssistantTextFromApiContent
} from '../../services/chatToolSessionService'
import { parseSkillCommand } from '../../services/skillCommandService'
import { appendSkillActivationLog } from '../../services/skillActivationLog'
import { filterBuiltinToolsForRenderer } from '../../../shared/toolsConfigFilter'
import { buildSystemPromptFromSkills, formatSkillHint, truncateSystemPrompt } from '../../../shared/skillPrompt'
import type { Message } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE, normalizeSessionSkillsState } from '../../../shared/domainTypes'
import { resolveEffectiveOutputMaxTokens } from '../../../shared/llm/outputMaxTokens'
import { ChatBubble } from './ChatBubble'
import { MessageInput } from './MessageInput'
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
  const dispatch = useAppDispatch()
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const messages = useTypedSelector((s) => s.chat.messages)
  const chatStatus = useTypedSelector((s) => s.chat.chatStatus)
  const streamingRequestId = useTypedSelector((s) => s.chat.streamingRequestId)
  const cfg = useTypedSelector((s) => s.config.config)
  const currentSession = useTypedSelector((s) => s.session.list.find((x) => x.id === s.chat.currentSessionId))
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRequestedRef = useRef(false)
  const [skillHints, setSkillHints] = useState<string[]>([])

  const streamingAssistantId = useMemo(
    () => messages.find((m) => m.role === 'assistant' && m.status === 'streaming')?.id,
    [messages]
  )

  useEffect(() => {
    if (!sessionId) {
      dispatch(setMessages([]))
      return
    }
    void window.api.chatGetMessages({ sessionId }).then((rows) => dispatch(setMessages(rows)))
  }, [sessionId, dispatch])

  const scrollBottom = () => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  const onToolConfirm = useCallback(
    (toolUseId: string, approved: boolean) => {
      if (!streamingRequestId) return
      void window.api.toolConfirmResponse({ requestId: streamingRequestId, toolUseId, approved })
    },
    [streamingRequestId]
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
      assistantId: string,
      contentState: ContentState,
      thinkingState: ThinkingState,
      toolCalls?: Message['toolCalls']
    ) => {
      if (!sessionId) return
      const thinking = finalizeThinking(thinkingState)
      const contentSegments = finalizeContentSegments(contentState)
      const patch = {
        content: contentState.content,
        contentSegments,
        status: 'completed' as const,
        thinking,
        toolCalls
      }
      dispatch(patchMessage({ id: assistantId, patch }))
      await window.api.chatPatchMessage({
        messageId: assistantId,
        sessionId,
        patch
      })
      dispatch(setChatStatus({ status: 'completed', requestId: null }))
      message.info(CHAT_CANCELLED_MESSAGE)
      scrollBottom()
    },
    [dispatch, sessionId]
  )

  const send = useCallback(
    async (text: string) => {
      const liveStatus = store.getState().chat.chatStatus
      if (liveStatus === 'streaming' || liveStatus === 'sending') return
      if (!sessionId || !cfg) {
        message.warning('请先选择会话并等待配置加载')
        return
      }
      if (!cfg.apiKeyPresent) {
        message.warning('请先在设置中配置 API Key')
        return
      }

      const sessionSkillsState = normalizeSessionSkillsState(currentSession?.skillsState ?? DEFAULT_SESSION_SKILLS_STATE)
      const cmd = await parseSkillCommand(text, sessionSkillsState)
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
        sessionId,
        role: 'user',
        content: text,
        timestamp: Date.now(),
        status: 'sent',
        schemaVersion: CURRENT_SCHEMA_VERSION
      }

      dispatch(addMessage(userMsg))
      await window.api.chatAppendMessage(userMsg)

      const assistantId = crypto.randomUUID()
      const assistantMsg: Message = {
        id: assistantId,
        sessionId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        status: 'streaming',
        schemaVersion: CURRENT_SCHEMA_VERSION
      }
      dispatch(addMessage(assistantMsg))
      await window.api.chatAppendMessage(assistantMsg)

      const requestId = crypto.randomUUID()
      abortRequestedRef.current = false
      dispatch(setChatStatus({ status: 'streaming', requestId, sessionId }))

      const historyForApi = [...messages, userMsg]
      const useToolsApi = cfg.tools.enabled && filterBuiltinToolsForRenderer(cfg.tools).length > 0

      const activeSkills = await window.api.skillMatch({ userInput: text, sessionSkillsState })
      if (activeSkills.length > 0) {
        setSkillHints((prev) => [...prev, formatSkillHint(activeSkills, '已自动加载')])
        scrollBottom()
        const metadata = appendSkillActivationLog(currentSession?.metadata ?? {}, {
          skillNames: activeSkills.map((s) => s.meta.name),
          source: 'auto',
          userInput: text
        })
        void window.api.sessionUpdate({ sessionId, metadata }).then((updated) => {
          if (updated) dispatch(upsertSession(updated))
        })
      }

      const modelEntry = cfg.models.find((m) => m.name === cfg.model)
      const outputMaxTokens = resolveEffectiveOutputMaxTokens(cfg.model, cfg.models, cfg.maxTokens)
      const maxSystemChars = modelEntry ? Math.floor(modelEntry.maximumContext * 0.1) : undefined
      let systemPrompt = buildSystemPromptFromSkills(activeSkills)
      if (maxSystemChars && systemPrompt) {
        systemPrompt = truncateSystemPrompt(systemPrompt, maxSystemChars)
      }

      if (abortRequestedRef.current) {
        await finishCancelled(assistantId, createContentState(assistantMsg.timestamp), createThinkingState(assistantMsg.timestamp))
        return
      }

      let contentState = createContentState(assistantMsg.timestamp)
      let thinkingState = createThinkingState(assistantMsg.timestamp)

      if (useToolsApi) {
        const controller = createToolChatController({
          dispatch,
          assistantMessageId: assistantId,
          getRequestId: () => requestId,
          onRecordsChange: () => scrollBottom()
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
            dispatch(
              patchMessage({
                id: assistantId,
                patch: buildAssistantStreamPatch(thinkingState, contentState)
              })
            )
            scrollBottom()
          })
        )
        unsubs.push(
          window.api.claudeChatOnThinkingDelta((d) => {
            if (d.requestId !== requestId) return
            if (hasOpenContentSegment(contentState)) {
              contentState = closeOpenContentSegment(contentState)
            }
            thinkingState = appendThinkingDelta(thinkingState, d.text)
            dispatch(
              patchMessage({
                id: assistantId,
                patch: buildAssistantStreamPatch(thinkingState, contentState)
              })
            )
            scrollBottom()
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
            dispatch(
              patchMessage({
                id: assistantId,
                patch: buildAssistantStreamPatch(thinkingState, contentState)
              })
            )
          })
        )

        try {
          const payload = buildToolChatPayload({
            requestId,
            sessionId,
            model: cfg.model,
            baseUrl: cfg.baseUrl || undefined,
            messages: historyForApi,
            toolsConfig: cfg.tools,
            maxTokens: outputMaxTokens,
            thinkingEnabled: cfg.thinkingEnabled,
            system: systemPrompt || undefined
          })
          const res = await window.api.claudeChatCreateWithTools(payload)
          if (!res.ok) {
            if (isChatCancelledError(res.error) || abortRequestedRef.current) {
              const assistantRow = store.getState().chat.messages.find((m) => m.id === assistantId)
              await finishCancelled(assistantId, contentState, thinkingState, assistantRow?.toolCalls)
              return
            }
            dispatch(patchMessage({ id: assistantId, patch: { status: 'failed', content: contentState.content || res.error } }))
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId,
              patch: { status: 'failed', content: contentState.content || res.error }
            })
            dispatch(setChatStatus({ status: 'error', error: res.error, requestId: null }))
            message.error(res.error)
            return
          }
          const textOut = extractAssistantTextFromApiContent(res.content as unknown[]) || contentState.content
          if (textOut !== contentState.content) {
            contentState = { ...contentState, content: textOut }
          }
          const assistantRow = store.getState().chat.messages.find((m) => m.id === assistantId)
          const thinking = finalizeThinking(thinkingState)
          const contentSegments = finalizeContentSegments(contentState)
          dispatch(
            patchMessage({
              id: assistantId,
              patch: {
                content: textOut,
                contentSegments,
                status: 'completed',
                thinking,
                toolCalls: assistantRow?.toolCalls
              }
            })
          )
          await window.api.chatPatchMessage({
            messageId: assistantId,
            sessionId,
            patch: {
              content: textOut,
              contentSegments,
              status: 'completed',
              thinking,
              toolCalls: assistantRow?.toolCalls
            }
          })
          dispatch(setChatStatus({ status: 'completed', requestId: null }))
          scrollBottom()
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e)
          if (isChatCancelledError(err) || abortRequestedRef.current) {
            const assistantRow = store.getState().chat.messages.find((m) => m.id === assistantId)
            await finishCancelled(assistantId, contentState, thinkingState, assistantRow?.toolCalls)
            return
          }
          dispatch(patchMessage({ id: assistantId, patch: { status: 'failed', content: contentState.content || err } }))
          await window.api.chatPatchMessage({
            messageId: assistantId,
            sessionId,
            patch: { status: 'failed', content: contentState.content || err }
          })
          dispatch(setChatStatus({ status: 'error', error: err, requestId: null }))
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
            dispatch(
              patchMessage({
                id: assistantId,
                patch: buildAssistantStreamPatch(thinkingState, contentState)
              })
            )
            scrollBottom()
          },
          onThinkingDelta: (t) => {
            if (hasOpenContentSegment(contentState)) {
              contentState = closeOpenContentSegment(contentState)
            }
            thinkingState = appendThinkingDelta(thinkingState, t)
            dispatch(
              patchMessage({
                id: assistantId,
                patch: buildAssistantStreamPatch(thinkingState, contentState)
              })
            )
            scrollBottom()
          },
          onDone: async () => {
            const thinking = finalizeThinking(thinkingState)
            const contentSegments = finalizeContentSegments(contentState)
            dispatch(
              patchMessage({
                id: assistantId,
                patch: {
                  content: contentState.content,
                  contentSegments,
                  status: 'completed',
                  thinking
                }
              })
            )
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId,
              patch: {
                content: contentState.content,
                contentSegments,
                status: 'completed',
                thinking
              }
            })
            dispatch(setChatStatus({ status: 'completed', requestId: null }))
            scrollBottom()
          },
          onError: async (err) => {
            if (isChatCancelledError(err) || abortRequestedRef.current) {
              await finishCancelled(assistantId, contentState, thinkingState)
              return
            }
            dispatch(patchMessage({ id: assistantId, patch: { status: 'failed', content: contentState.content || err } }))
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId,
              patch: { status: 'failed', content: contentState.content || err }
            })
            dispatch(setChatStatus({ status: 'error', error: err, requestId: null }))
            message.error(err)
          }
        }
      )
    },
    [cfg, currentSession, dispatch, messages, sessionId, finishCancelled, onToolCancel, onToolConfirm]
  )

  const running = chatStatus === 'streaming' || chatStatus === 'sending'

  const toolsInteractive =
    cfg?.tools.enabled && chatStatus === 'streaming' && streamingRequestId && streamingAssistantId
      ? {
          requestId: streamingRequestId,
          confirmMode: cfg.tools.confirmMode,
          onToolConfirm,
          onToolCancel
        }
      : undefined

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
            <Text type="secondary">输入问题，或尝试 /skill 命令加载 Skill</Text>
          </div>
        ) : (
          messages.map((m) => (
            <ChatBubble
              key={m.id}
              message={m}
              toolsInteractive={m.id === streamingAssistantId ? toolsInteractive : undefined}
            />
          ))
        )}
      </div>
      <MessageInput
        disabled={!sessionId}
        running={running}
        modelLabel={cfg?.model}
        onSend={send}
        onAbort={abort}
      />
    </div>
  )
}
