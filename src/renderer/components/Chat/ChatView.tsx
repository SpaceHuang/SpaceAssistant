import { useCallback, useEffect, useRef } from 'react'
import { message } from 'antd'
import { useTypedSelector, useAppDispatch } from '../../hooks'
import { addMessage, patchMessage, setChatStatus, setMessages } from '../../store/chatSlice'
import { runClaudeChatStream } from '../../services/chatStreamService'
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
  const cfg = useTypedSelector((s) => s.config.config)
  const scrollRef = useRef<HTMLDivElement>(null)

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

      const basePayload = buildClaudePayload([...messages, userMsg])

      let buf = ''
      let think = ''

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
    [cfg, dispatch, messages, sessionId]
  )

  const busy = chatStatus === 'streaming' || chatStatus === 'sending'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} />
        ))}
      </div>
      <MessageInput disabled={busy || !sessionId} modelLabel={cfg?.model} onSend={send} />
    </div>
  )
}
