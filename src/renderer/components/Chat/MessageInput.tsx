import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Input, Select } from 'antd'
import { Send, Square } from 'lucide-react'
import type { ChatMode } from '../../../shared/planTypes'
import { DEFAULT_CHAT_MODE } from '../../../shared/planTypes'
import { ContextUsageRing } from './ContextUsageRing'

export type MessageInputHandle = {
  focus: () => void
  setDraft: (text: string) => void
  setChatMode: (mode: ChatMode) => void
}

type Props = {
  disabled?: boolean
  running?: boolean
  modelLabel?: string
  chatMode?: ChatMode
  defaultChatMode?: ChatMode
  onChatModeChange?: (mode: ChatMode) => void
  onSend: (text: string, chatMode: ChatMode) => void
  onAbort?: () => void
}

export const MessageInput = forwardRef<MessageInputHandle, Props>(function MessageInput(
  {
    disabled,
    running,
    modelLabel,
    chatMode: chatModeProp,
    defaultChatMode = DEFAULT_CHAT_MODE,
    onChatModeChange,
    onSend,
    onAbort
  },
  ref
) {
  const [text, setText] = useState('')
  const [localMode, setLocalMode] = useState<ChatMode>(defaultChatMode)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const chatMode = chatModeProp ?? localMode

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setDraft: (t: string) => setText(t),
    setChatMode: (mode: ChatMode) => {
      if (onChatModeChange) onChatModeChange(mode)
      else setLocalMode(mode)
    }
  }))

  const send = () => {
    const t = text.trim()
    if (!t || disabled || running) return
    setText('')
    onSend(t, chatMode)
  }

  const setMode = (mode: ChatMode) => {
    if (onChatModeChange) onChatModeChange(mode)
    else setLocalMode(mode)
  }

  const handlePrimaryAction = () => {
    if (running) {
      onAbort?.()
      return
    }
    send()
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <Input.TextArea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入消息…"
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handlePrimaryAction()
            }
          }}
        />
        <div className="composer-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
            <Select
              size="small"
              className="composer-mode-select"
              value={chatMode}
              disabled={disabled || running}
              onChange={setMode}
              options={[
                { value: 'normal', label: '普通模式' },
                { value: 'plan', label: 'Plan 模式' }
              ]}
              popupMatchSelectWidth={false}
            />
            {modelLabel ? <span className="composer-model-chip">{modelLabel}</span> : null}
            <span className="composer-hint">{running ? '执行中，Enter 或点击右侧按钮中止' : 'Enter 发送，Shift+Enter 换行'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ContextUsageRing />
            <button
              type="button"
              className={`composer-send${running ? ' composer-send--stop' : ''}`}
              onClick={handlePrimaryAction}
              disabled={running ? false : disabled || !text.trim()}
              title={running ? '中止' : '发送'}
            >
              {running ? <Square size={14} fill="currentColor" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
})