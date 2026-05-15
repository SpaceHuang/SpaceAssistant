import { Card, Collapse, Space, Tag, Typography } from 'antd'
import type { Message } from '../../../shared/domainTypes'
import { ChatMarkdown } from './ChatMarkdown'

const { Text } = Typography

type Props = {
  message: Message
}

export function ChatBubble({ message }: Props) {
  const isUser = message.role === 'user'
  const align = isUser ? 'flex-end' : 'flex-start'
  const bg = isUser ? '#1677ff' : 'var(--sa-bubble-assistant, #f0f0f0)'
  const color = isUser ? '#fff' : 'inherit'

  return (
    <div style={{ display: 'flex', justifyContent: align, marginBottom: 12 }}>
      <div
        style={{
          maxWidth: '85%',
          background: bg,
          color,
          padding: '10px 14px',
          borderRadius: 12,
          wordBreak: 'break-word'
        }}
      >
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {message.thinking && message.thinking.content ? (
            <Collapse
              size="small"
              items={[
                {
                  key: 'think',
                  label: '思考过程',
                  children: <Text type="secondary">{message.thinking.content}</Text>
                }
              ]}
            />
          ) : null}
          {message.toolUse ? (
            <Card size="small" title={<Text strong>工具: {message.toolUse.toolName}</Text>}>
              <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(message.toolUse.parameters, null, 2)}
              </pre>
              {message.toolUse.result ? (
                <Tag color={message.toolUse.result.success ? 'green' : 'red'} style={{ marginTop: 8 }}>
                  {message.toolUse.result.success ? '成功' : '失败'}
                </Tag>
              ) : null}
            </Card>
          ) : null}
          <div className={isUser ? 'chat-md-user' : 'chat-md-assistant'}>
            {isUser ? (
              <Text style={{ color }}>{message.content}</Text>
            ) : (
              <ChatMarkdown content={message.content || '…'} />
            )}
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {new Date(message.timestamp).toLocaleString()}
            {message.status === 'streaming' ? ' · 生成中' : null}
            {message.status === 'failed' ? ' · 失败' : null}
          </Text>
        </Space>
      </div>
    </div>
  )
}
