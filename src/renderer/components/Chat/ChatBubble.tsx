import { memo } from 'react'
import type { Message, ShellConfig } from '../../../shared/domainTypes'
import { buildAssistantActivityTimeline } from '../../../shared/assistantActivityTimeline'
import { contentSegmentsForRender } from '../../../shared/contentSegments'
import { thinkingSegmentsForRender } from '../../../shared/thinkingSegments'
import { ChatMarkdown } from './ChatMarkdown'
import { formatChatTimestamp } from './formatChatTimestamp'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { SkillHintRow } from './SkillHintRow'
import { formatToolLabel, formatToolLabelTitle } from './toolCallDisplay'
import { SkillHintBubble } from './SkillHintBubble'
import { ToolRowIcon } from './ToolRowIcon'

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
  workDir?: string
  shellConfig?: ShellConfig
  sessionMetadata?: Record<string, unknown>
  onOpenFile?: (relPath: string) => void
  wikiRootPath?: string
  showArchiveToWiki?: boolean
  onArchiveToWiki?: () => void
  onRetry?: () => void
}

function AssistantTextBody({
  activeText,
  body,
  onOpenFile,
  wikiRootPath
}: {
  activeText: boolean
  body: string
  onOpenFile?: (relPath: string) => void
  wikiRootPath?: string
}) {
  if (activeText) {
    return <div className="chat-stream-plain chat-md-assistant">{body}</div>
  }
  return <ChatMarkdown content={body} onOpenFile={onOpenFile} wikiRootPath={wikiRootPath} />
}

function MessageMeta({
  timestamp,
  streaming,
  failed,
  showArchiveToWiki,
  onArchiveToWiki
}: {
  timestamp: number
  streaming: boolean
  failed: boolean
  showArchiveToWiki?: boolean
  onArchiveToWiki?: () => void
}) {
  return (
    <div className="chat-bubble-meta">
      <time dateTime={new Date(timestamp).toISOString()}>{formatChatTimestamp(timestamp)}</time>
      {streaming ? <span className="chat-bubble-status chat-bubble-status--streaming">生成中</span> : null}
      {failed ? <span className="chat-bubble-status chat-bubble-status--failed">失败</span> : null}
      {showArchiveToWiki && onArchiveToWiki ? (
        <button type="button" className="chat-archive-wiki-btn" onClick={onArchiveToWiki}>
          归档到 Wiki
        </button>
      ) : null}
    </div>
  )
}

export const ChatBubble = memo(function ChatBubble({
  message,
  toolsInteractive,
  focusToolUseId,
  workDir,
  shellConfig,
  sessionMetadata,
  onOpenFile,
  wikiRootPath,
  showArchiveToWiki = false,
  onArchiveToWiki,
  onRetry
}: Props) {
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'
  const failed = message.status === 'failed'
  const thinkingSegments = message.thinking ? thinkingSegmentsForRender(message.thinking) : []
  const textSegments = contentSegmentsForRender(message)
  const toolById = new Map((message.toolCalls ?? []).map((tc) => [tc.id, tc]))
  const skillById = new Map((message.skillHints ?? []).map((h) => [h.id, h]))
  const activityTimeline = !isUser && message.role !== 'system' ? buildAssistantActivityTimeline(message) : []

  if (message.role === 'system') {
    const hints = message.skillHints ?? []
    if (hints.length === 0) return null
    return <SkillHintBubble hints={hints} />
  }

  if (isUser) {
    return (
      <div className="chat-bubble-row chat-bubble-row--user" data-message-id={message.id}>
        <div className="chat-bubble-col chat-bubble-col--user">
          <div className="chat-bubble chat-bubble--user">
            <div className="chat-md-user">{message.content}</div>
          </div>
          <MessageMeta timestamp={message.timestamp} streaming={false} failed={false} />
        </div>
      </div>
    )
  }

  const rowClass = [
    'chat-bubble-row',
    'chat-bubble-row--assistant',
    streaming ? 'chat-bubble-row--streaming' : '',
    failed ? 'chat-bubble-row--failed' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rowClass} data-message-id={message.id}>
      <div
        className="chat-bubble-col chat-bubble-col--assistant"
        role="region"
        aria-label="助手回复"
        aria-live={streaming ? 'polite' : undefined}
        aria-busy={streaming ? true : undefined}
      >
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
                    <AssistantTextBody
                      activeText={activeText}
                      body={body}
                      onOpenFile={onOpenFile}
                      wikiRootPath={wikiRootPath}
                    />
                  </div>
                )
              }
              if (item.kind === 'skill') {
                const hint = skillById.get(item.hintId)
                if (!hint) return null
                return (
                  <div key={`${message.id}-act-skill-${hint.id}`} className="chat-system-track">
                    <SkillHintRow text={hint.text} />
                  </div>
                )
              }
              const tc = toolById.get(item.toolId)
              if (!tc) return null
              return (
                <ToolCallCard
                  key={`${message.id}-act-tool-${tc.id}`}
                  record={tc}
                  messageId={message.id}
                  sessionId={message.sessionId}
                  toolCalls={message.toolCalls}
                  workDir={workDir}
                  shellConfig={shellConfig}
                  sessionMetadata={sessionMetadata}
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
            {streaming && !message.content && thinkingSegments.every((seg) => seg.endTime !== undefined) ? (
              <div className="chat-bubble chat-bubble--assistant chat-bubble-streaming">
                <div className="chat-stream-plain chat-md-assistant">…</div>
              </div>
            ) : null}
          </div>
        ) : streaming ? (
          <div className="chat-bubble chat-bubble--assistant chat-bubble-streaming">
            <div className="chat-stream-plain chat-md-assistant">…</div>
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

        {failed ? (
          <div className="chat-message-error" role="alert">
            <span className="chat-message-error__text">
              回复未能完成。你可以重试生成，或基于已有上下文继续对话。
            </span>
            {onRetry ? (
              <button type="button" className="chat-message-error__retry" onClick={onRetry}>
                重试回复
              </button>
            ) : null}
          </div>
        ) : null}

        <MessageMeta
          timestamp={message.timestamp}
          streaming={streaming}
          failed={failed}
          showArchiveToWiki={showArchiveToWiki}
          onArchiveToWiki={onArchiveToWiki}
        />
      </div>
    </div>
  )
}, (prev, next) =>
  prev.message === next.message &&
  prev.focusToolUseId === next.focusToolUseId &&
  prev.toolsInteractive === next.toolsInteractive &&
  prev.onOpenFile === next.onOpenFile &&
  prev.wikiRootPath === next.wikiRootPath &&
  prev.showArchiveToWiki === next.showArchiveToWiki &&
  prev.onArchiveToWiki === next.onArchiveToWiki &&
  prev.onRetry === next.onRetry
)
