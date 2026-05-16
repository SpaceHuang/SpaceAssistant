import { Space, Typography } from 'antd'
import type { Message } from '../../../shared/domainTypes'
import { buildAssistantActivityTimeline } from '../../../shared/assistantActivityTimeline'
import { contentSegmentsForRender } from '../../../shared/contentSegments'
import { thinkingSegmentsForRender } from '../../../shared/thinkingSegments'
import { ChatMarkdown } from './ChatMarkdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { formatToolLabel, formatToolLabelTitle } from './toolCallDisplay'
import { ToolRowIcon } from './ToolRowIcon'

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
  focusToolUseId?: string | null
  onOpenFile?: (relPath: string) => void
}

export function ChatBubble({ message, toolsInteractive, focusToolUseId, onOpenFile }: Props) {
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'
  const thinkingSegments = message.thinking ? thinkingSegmentsForRender(message.thinking) : []
  const textSegments = contentSegmentsForRender(message)
  const toolById = new Map((message.toolCalls ?? []).map((tc) => [tc.id, tc]))
  const activityTimeline = !isUser ? buildAssistantActivityTimeline(message) : []

  if (isUser) {
    return (
      <div className="chat-bubble-row chat-bubble-row--user">
        <div style={{ maxWidth: '92%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div className="chat-bubble chat-bubble--user">
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <div className="chat-md-user">
                <Text style={{ color: 'var(--sa-bubble-user-text)' }}>{message.content}</Text>
              </div>
              <div className="chat-bubble-meta">
                {new Date(message.timestamp).toLocaleString()}
              </div>
            </Space>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-bubble-row chat-bubble-row--assistant">
      <div style={{ maxWidth: '92%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
        {activityTimeline.length > 0 ? (
          <div className="chat-activity-track">
            {activityTimeline.map((item, i) => {
              if (item.kind === 'thinking') {
                const seg = thinkingSegments[item.segmentIndex]
                if (!seg) return null
                return (
                  <ThinkingBlock
                    key={`${message.id}-act-think-${i}`}
                    content={seg.content}
                    active={streaming && seg.endTime === undefined}
                  />
                )
              }
              if (item.kind === 'text') {
                const seg = textSegments[item.segmentIndex]
                if (!seg) return null
                const activeText = streaming && seg.endTime === undefined
                const body = activeText && !seg.content ? '…' : seg.content
                return (
                  <div
                    key={`${message.id}-act-text-${i}`}
                    className={`chat-bubble chat-bubble--assistant${activeText ? ' chat-bubble-streaming' : ''}`}
                  >
                    <ChatMarkdown content={body} />
                  </div>
                )
              }
              const tc = toolById.get(item.toolId)
              if (!tc) return null
              return (
                <ToolCallCard
                  key={`${message.id}-act-tool-${tc.id}`}
                  record={tc}
                  focus={focusToolUseId === tc.id}
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
                  onOpenFile={onOpenFile}
                />
              )
            })}
          </div>
        ) : streaming ? (
          <div className="chat-bubble chat-bubble--assistant chat-bubble-streaming">
            <ChatMarkdown content="…" />
          </div>
        ) : null}

        {message.toolUse ? (
          <div className="tool-row">
            <div className="tool-row__main">
              <ToolRowIcon toolName={message.toolUse.toolName} />
              <span
                className="tool-row__label"
                title={
                  formatToolLabelTitle(message.toolUse.toolName, message.toolUse.parameters) ??
                  formatToolLabel(message.toolUse.toolName, message.toolUse.parameters)
                }
              >
                {formatToolLabel(message.toolUse.toolName, message.toolUse.parameters)}
              </span>
            </div>
          </div>
        ) : null}

        <div className="chat-bubble-meta">
          {new Date(message.timestamp).toLocaleString()}
          {streaming ? ' · 生成中' : null}
          {message.status === 'failed' ? ' · 失败' : null}
        </div>
      </div>
    </div>
  )
}

