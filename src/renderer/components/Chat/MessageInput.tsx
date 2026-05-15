import { useState } from 'react'
import { Input } from 'antd'
import { Send } from 'lucide-react'

type Props = {
  disabled?: boolean
  modelLabel?: string
  onSend: (text: string) => void
}

export function MessageInput({ disabled, modelLabel, onSend }: Props) {
  const [text, setText] = useState('')

  const send = () => {
    const t = text.trim()
    if (!t || disabled) return
    setText('')
    onSend(t)
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
              send()
            }
          }}
        />
        <div className="composer-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {modelLabel ? <span className="composer-model-chip">{modelLabel}</span> : null}
            <span className="composer-hint">Ctrl+Enter 发送</span>
          </div>
          <button type="button" className="composer-send" onClick={send} disabled={disabled || !text.trim()} title="发送">
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
