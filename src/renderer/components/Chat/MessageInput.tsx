import { useState } from 'react'
import { Input } from 'antd'
import { Send, Square } from 'lucide-react'

type Props = {
  disabled?: boolean
  running?: boolean
  modelLabel?: string
  onSend: (text: string) => void
  onAbort?: () => void
}

export function MessageInput({ disabled, running, modelLabel, onSend, onAbort }: Props) {
  const [text, setText] = useState('')

  const send = () => {
    const t = text.trim()
    if (!t || disabled || running) return
    setText('')
    onSend(t)
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
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入消息…"
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              handlePrimaryAction()
            }
          }}
        />
        <div className="composer-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {modelLabel ? <span className="composer-model-chip">{modelLabel}</span> : null}
            <span className="composer-hint">{running ? '执行中，点击右侧按钮中止' : 'Ctrl+Enter 发送'}</span>
          </div>
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
  )
}
