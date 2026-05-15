import { useCallback, useEffect, useMemo, useRef } from 'react'
import { message } from 'antd'
import { useTypedSelector, useAppDispatch } from '../../hooks'
import { addMessage, patchMessage, setChatStatus, setMessages } from '../../store/chatSlice'
import { store } from '../../store'
import { runClaudeChatStream } from '../../services/chatStreamService'
import {
  buildToolChatPayload,
  createToolChatController,
  extractAssistantTextFromApiContent
} from '../../services/chatToolSessionService'
import { filterBuiltinToolsForRenderer } from '../../../shared/toolsConfigFilter'
import type { Message } from '../../../shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../../../shared/domainTypes'
import { ChatBubble } from './ChatBubble'
import { MessageInput } from './MessageInput'

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
  const dispatch = useAppDispatch()
  const sessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const messages = useTypedSelector((s) => s.chat.messages)
  const chatStatus = useTypedSelector((s) => s.chat.chatStatus)
  const streamingRequestId = useTypedSelector((s) => s.chat.streamingRequestId)
  const cfg = useTypedSelector((s) => s.config.config)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || !cfg) {
        message.warning('请先选择会话并等待配置加载')
        return
      }
      if (!cfg.apiKeyPresent) {
        message.warning('请先在设置中配置 API Key')
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
      dispatch(setChatStatus({ status: 'streaming', requestId }))

      const historyForApi = [...messages, userMsg]
      const useToolsApi = cfg.tools.enabled && filterBuiltinToolsForRenderer(cfg.tools).length > 0

      let buf = ''
      let think = ''

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
            buf += d.text
            dispatch(patchMessage({ id: assistantId, patch: { content: buf } }))
            scrollBottom()
          })
        )
        unsubs.push(
          window.api.claudeChatOnThinkingDelta((d) => {
            if (d.requestId !== requestId) return
            think += d.text
            dispatch(
              patchMessage({
                id: assistantId,
                patch: {
                  thinking: {
                    content: think,
                    isVisible: true,
                    startTime: assistantMsg.timestamp,
                    endTime: undefined
                  }
                }
              })
            )
            scrollBottom()
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
            maxTokens: cfg.maxTokens,
            thinkingEnabled: cfg.thinkingEnabled
          })
          const res = await window.api.claudeChatCreateWithTools(payload)
          if (!res.ok) {
            dispatch(patchMessage({ id: assistantId, patch: { status: 'failed', content: buf || res.error } }))
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId,
              patch: { status: 'failed', content: buf || res.error }
            })
            dispatch(setChatStatus({ status: 'error', error: res.error, requestId: null }))
            message.error(res.error)
            return
          }
          const textOut = extractAssistantTextFromApiContent(res.content as unknown[]) || buf
          const assistantRow = store.getState().chat.messages.find((m) => m.id === assistantId)
          dispatch(
            patchMessage({
              id: assistantId,
              patch: {
                content: textOut,
                status: 'completed',
                thinking: think
                  ? {
                      content: think,
                      isVisible: true,
                      startTime: assistantMsg.timestamp,
                      endTime: Date.now()
                    }
                  : undefined,
                toolCalls: assistantRow?.toolCalls
              }
            })
          )
          await window.api.chatPatchMessage({
            messageId: assistantId,
            sessionId,
            patch: {
              content: textOut,
              status: 'completed',
              thinking: think
                ? {
                    content: think,
                    isVisible: true,
                    startTime: assistantMsg.timestamp,
                    endTime: Date.now()
                  }
                : undefined,
              toolCalls: assistantRow?.toolCalls
            }
          })
          dispatch(setChatStatus({ status: 'completed', requestId: null }))
          scrollBottom()
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e)
          dispatch(patchMessage({ id: assistantId, patch: { status: 'failed', content: buf || err } }))
          await window.api.chatPatchMessage({
            messageId: assistantId,
            sessionId,
            patch: { status: 'failed', content: buf || err }
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
          messages: basePayload
        },
        {
          onDelta: (t) => {
            buf += t
            dispatch(patchMessage({ id: assistantId, patch: { content: buf } }))
            scrollBottom()
          },
          onThinkingDelta: (t) => {
            think += t
            dispatch(
              patchMessage({
                id: assistantId,
                patch: {
                  thinking: {
                    content: think,
                    isVisible: true,
                    startTime: assistantMsg.timestamp,
                    endTime: undefined
                  }
                }
              })
            )
            scrollBottom()
          },
          onDone: async () => {
            dispatch(
              patchMessage({
                id: assistantId,
                patch: {
                  content: buf,
                  status: 'completed',
                  thinking: think
                    ? {
                        content: think,
                        isVisible: true,
                        startTime: assistantMsg.timestamp,
                        endTime: Date.now()
                      }
                    : undefined
                }
              })
            )
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId,
              patch: {
                content: buf,
                status: 'completed',
                thinking: think
                  ? {
                      content: think,
                      isVisible: true,
                      startTime: assistantMsg.timestamp,
                      endTime: Date.now()
                    }
                  : undefined
              }
            })
            dispatch(setChatStatus({ status: 'completed', requestId: null }))
            scrollBottom()
          },
          onError: async (err) => {
            dispatch(patchMessage({ id: assistantId, patch: { status: 'failed', content: buf || err } }))
            await window.api.chatPatchMessage({
              messageId: assistantId,
              sessionId,
              patch: { status: 'failed', content: buf || err }
            })
            dispatch(setChatStatus({ status: 'error', error: err, requestId: null }))
            message.error(err)
          }
        }
      )
    },
    [cfg, dispatch, messages, sessionId, onToolCancel, onToolConfirm]
  )

  const busy = chatStatus === 'streaming' || chatStatus === 'sending'

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {messages.map((m) => (
          <ChatBubble
            key={m.id}
            message={m}
            toolsInteractive={m.id === streamingAssistantId ? toolsInteractive : undefined}
          />
        ))}
      </div>
      <MessageInput disabled={busy || !sessionId} modelLabel={cfg?.model} onSend={send} />
    </div>
  )
}
