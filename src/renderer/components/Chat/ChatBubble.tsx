import { Collapse, Space, Tag, Typography } from 'antd'
import type { Message } from '../../../shared/domainTypes'
import { ChatMarkdown } from './ChatMarkdown'
import { ToolCallCard } from './ToolCallCard'

const { Text } = Typography

export type ToolsInteractiveProps = {
  requestId: string
  confirmMode: 'diff' | 'direct'
  onToolConfirm: (toolUseId: string, approved: boolean) => void
  onToolCancel: (toolUseId: string) => void
}

type Props = {
  message: Message
  toolsInteractive?: ToolsInteractiveProps
  onOpenFile?: (relPath: string) => void
}

export function ChatBubble({ message, toolsInteractive }: Props) {
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'

  return (
    <div className={`chat-bubble-row chat-bubble-row--${isUser ? 'user' : 'assistant'}`}>
      <div style={{ maxWidth: '92%', display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <div className={`chat-bubble chat-bubble--${isUser ? 'user' : 'assistant'}${streaming && !isUser ? ' chat-bubble-streaming' : ''}`}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {message.thinking?.content ? (
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

          <div className={isUser ? 'chat-md-user' : undefined}>
            {isUser ? (
              <Text style={{ color: 'var(--sa-bubble-user-text)' }}>{message.content}</Text>
            ) : (
              <ChatMarkdown content={message.content || '…'} />
            )}
          </div>

          {message.toolUse ? (
            <div className="tool-card" style={{ marginTop: 8 }}>
              <div className="tool-card-header" style={{ cursor: 'default' }}>
                <span className="tool-card-name">工具: {message.toolUse.toolName}</span>
              </div>
              <div className="tool-card-body">
                <pre className="tool-code-preview" style={{ maxHeight: 200 }}>
                  {JSON.stringify(message.toolUse.parameters, null, 2)}
                </pre>
                {message.toolUse.result ? (
                  <Tag color={message.toolUse.result.success ? 'green' : 'red'} style={{ marginTop: 8 }}>
                    {message.toolUse.result.success ? '成功' : '失败'}
                  </Tag>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="chat-bubble-meta">
            {new Date(message.timestamp).toLocaleString()}
            {streaming ? ' · 生成中' : null}
            {message.status === 'failed' ? ' · 失败' : null}
          </div>
        </Space>
      </div>

      {message.toolCalls?.length ? (
        <div className="chat-tool-track">
          {message.toolCalls.map((tc) => (
            <ToolCallCard
              key={tc.id}
              record={tc}
              confirmMode={toolsInteractive?.confirmMode ?? 'diff'}
              onConfirm={
                toolsInteractive && tc.status === 'confirming'
                  ? (approved) => toolsInteractive.onToolConfirm(tc.id, approved)
                  : undefined
              }
              onCancel={
                toolsInteractive && tc.status === 'executing'
                  ? () => toolsInteractive.onToolCancel(tc.id)
                  : undefined
              }
            />
          ))}
        </div>
      ) : null}
      </div>
    </div>
  )
}
