import { useState } from 'react'
import { Button, Input, Space, Typography } from 'antd'

const { Text } = Typography

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
    <div style={{ borderTop: '1px solid #f0f0f0', padding: 12 }}>
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入消息…（Ctrl+Enter 发送）"
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              send()
            }
          }}
        />
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Text type="secondary">{modelLabel ?? ''}</Text>
          <Button type="primary" onClick={send} disabled={disabled || !text.trim()}>
            发送
          </Button>
        </Space>
      </Space>
    </div>
  )
}
