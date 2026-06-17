import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Brain } from 'lucide-react'
import type { Message, ShellConfig, ToolCallRecord } from '../../../shared/domainTypes'
import {
  buildAssistantActivityTimeline,
  type AssistantActivityItem
} from '../../../shared/assistantActivityTimeline'
import {
  buildActivityItemTimestampResolver,
  findBatchHighlightItem,
  groupActivityTimeline,
  isActivityBatchInProgress,
  type ActivityTrackSegment
} from '../../../shared/activityBatchGrouping'
import { contentSegmentsForRender } from '../../../shared/contentSegments'
import { thinkingSegmentsForRender } from '../../../shared/thinkingSegments'
import { ChatMarkdown } from './ChatMarkdown'
import { formatChatTimestamp } from './formatChatTimestamp'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { SkillHintRow } from './SkillHintRow'
import { formatToolLabel, formatToolLabelTitle } from './toolCallDisplay'
import {
  formatStreamingElapsed,
  resolveStreamingActivityStatus
} from '../../../shared/streamingActivityStatus'
import { SkillHintBubble } from './SkillHintBubble'
import { ToolRowIcon } from './ToolRowIcon'
import { ActivityBatch, type ActivityBatchSummary } from './ActivityBatch'
import { ChatMessageAttachments } from './ChatMessageAttachments'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { FileConfirmMode } from '../../../shared/domainTypes'
import type { ToolConfirmOptions } from '../../../shared/toolConfirm'

export type ToolsInteractiveProps = {
  requestId: string
  confirmMode: FileConfirmMode
  onToolConfirm: (toolUseId: string, approved: boolean, options?: ToolConfirmOptions) => void
  onToolCancel: (toolUseId: string) => void
}

type Props = {
  message: Message
  /** 新追加的消息行入场动效（由 ChatView 按条数增量判定） */
  enter?: boolean
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
  onCancelQueued?: () => void
}


function buildBatchSummary(
  items: AssistantActivityItem[],
  ctx: {
    toolById: Map<string, ToolCallRecord>
    thinkingSegments: ReturnType<typeof thinkingSegmentsForRender>
    t: ReturnType<typeof useTypedTranslation<'chat'>>['t']
  }
): ActivityBatchSummary {
  const count = items.length
  const highlight =
    findBatchHighlightItem(items, {
      thinkingSegments: ctx.thinkingSegments,
      toolById: ctx.toolById
    }) ?? items[0]!
  const allThinking = items.every((item) => item.kind === 'thinking')

  if (allThinking || highlight.kind === 'thinking') {
    const base = ctx.t('thinking.label')
    const label = count > 1 ? ctx.t('batch.thinkingCount', { count }) : base
    return {
      icon: <Brain size={14} strokeWidth={1.75} />,
      label
    }
  }

  if (highlight.kind === 'tool') {
    const tc = ctx.toolById.get(highlight.toolId)
    if (tc) {
      const base = formatToolLabel(tc.toolName, tc.input, ctx.t)
      const label = count > 1 ? `${base} ${ctx.t('batch.count', { count })}` : base
      return {
        icon: <ToolRowIcon toolName={tc.toolName} pending={tc.status === 'calling' || tc.status === 'executing'} />,
        label
      }
    }
  }

  return {
    icon: <Brain size={14} strokeWidth={1.75} />,
    label: ctx.t('thinking.label')
  }
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
  message,
  streaming,
  failed,
  queued = false,
  onCancelQueued,
  showArchiveToWiki,
  onArchiveToWiki
}: {
  message: Message
  streaming: boolean
  failed: boolean
  queued?: boolean
  onCancelQueued?: () => void
  showArchiveToWiki?: boolean
  onArchiveToWiki?: () => void
}) {
  const { t } = useTypedTranslation('chat')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!streaming) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming])

  const activityStatus = useMemo(() => {
    if (!streaming) return null
    return resolveStreamingActivityStatus({
      message,
      formatToolLabel: (toolName, input) => formatToolLabel(toolName, input, t),
      t,
      now
    })
  }, [message, streaming, t, now])

  const elapsedLabel =
    activityStatus?.showElapsed && streaming
      ? formatStreamingElapsed(now - message.timestamp)
      : null

  return (
    <div className="chat-bubble-meta">
      <time dateTime={new Date(message.timestamp).toISOString()}>{formatChatTimestamp(message.timestamp)}</time>
      {streaming && activityStatus ? (
        <span className="chat-bubble-status chat-bubble-status--streaming" title={activityStatus.detail}>
          {activityStatus.label}
          {elapsedLabel ? <span className="chat-bubble-status__elapsed">{elapsedLabel}</span> : null}
        </span>
      ) : null}
      {queued ? <span className="chat-bubble-status chat-bubble-status--queued">{t('streaming.queued')}</span> : null}
      {queued && onCancelQueued ? (
        <button type="button" className="chat-cancel-queue-btn" onClick={onCancelQueued}>
          {t('streaming.cancelQueue')}
        </button>
      ) : null}
      {failed ? <span className="chat-bubble-status chat-bubble-status--failed">{t('streaming.failed')}</span> : null}
      {showArchiveToWiki && onArchiveToWiki ? (
        <button type="button" className="chat-archive-wiki-btn" onClick={onArchiveToWiki}>
          {t('bubble.archiveToWiki')}
        </button>
      ) : null}
    </div>
  )
}

export const ChatBubble = memo(function ChatBubble({
  message,
  enter = false,
  toolsInteractive,
  focusToolUseId,
  workDir,
  shellConfig,
  sessionMetadata,
  onOpenFile,
  wikiRootPath,
  showArchiveToWiki = false,
  onArchiveToWiki,
  onRetry,
  onCancelQueued
}: Props) {
  const { t } = useTypedTranslation('chat')
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'
  const failed = message.status === 'failed'
  const thinkingSegments = message.thinking ? thinkingSegmentsForRender(message.thinking) : []
  const textSegments = contentSegmentsForRender(message)
  const toolById = new Map((message.toolCalls ?? []).map((tc) => [tc.id, tc]))
  const skillById = new Map((message.skillHints ?? []).map((h) => [h.id, h]))
  const activityTimeline = !isUser && message.role !== 'system' ? buildAssistantActivityTimeline(message) : []
  const getTimestamp = useMemo(() => buildActivityItemTimestampResolver(message), [message])
  const activitySegments = useMemo(
    () => groupActivityTimeline(activityTimeline, getTimestamp),
    [activityTimeline, getTimestamp]
  )
  const batchProgressCtx = useMemo(
    () => ({ streaming, thinkingSegments, toolById }),
    [streaming, thinkingSegments, toolById]
  )

  const lastBatchSegmentIndex = useMemo(() => {
    for (let i = activitySegments.length - 1; i >= 0; i--) {
      if (activitySegments[i]?.kind === 'batch') return i
    }
    return -1
  }, [activitySegments])

  if (message.role === 'system') {
    const hints = message.skillHints ?? []
    if (hints.length === 0) return null
    return <SkillHintBubble hints={hints} />
  }

  if (isUser) {
    return (
      <div
        className={['chat-bubble-row', 'chat-bubble-row--user', enter ? 'chat-bubble-row--enter' : '', message.status === 'queued' ? 'chat-bubble-row--queued' : '']
          .filter(Boolean)
          .join(' ')}
        data-message-id={message.id}
      >
        <div className="chat-bubble-col chat-bubble-col--user">
          <div className="chat-bubble chat-bubble--user">
            {message.attachments?.length ? (
              <ChatMessageAttachments sessionId={message.sessionId} attachments={message.attachments} />
            ) : null}
            <div className="chat-md-user">{message.content}</div>
          </div>
          <MessageMeta
            message={message}
            streaming={false}
            failed={false}
            queued={message.status === 'queued'}
            onCancelQueued={onCancelQueued}
          />
        </div>
      </div>
    )
  }

  const renderActivityItem = (item: AssistantActivityItem, key: string): ReactNode => {
    if (item.kind === 'thinking') {
      const seg = thinkingSegments[item.segmentIndex]
      if (!seg) return null
      return (
        <ThinkingBlock
          key={key}
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
          key={key}
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
        <div key={key} className="chat-system-track">
          <SkillHintRow text={hint.text} />
        </div>
      )
    }
    const tc = toolById.get(item.toolId)
    if (!tc) return null
    return (
      <ToolCallCard
        key={key}
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
            ? (approved, options) => toolsInteractive.onToolConfirm(tc.id, approved, options)
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
  }

  const renderActivitySegment = (segment: ActivityTrackSegment, segmentIndex: number) => {
    if (segment.kind === 'standalone') {
      return renderActivityItem(segment.item, `${message.id}-act-${segmentIndex}`)
    }

    const isLastBatch = segmentIndex === lastBatchSegmentIndex
    const batchInProgress = isActivityBatchInProgress(segment.items, batchProgressCtx)
    const isActive = isLastBatch && batchInProgress

    return (
      <ActivityBatch
        key={`${message.id}-batch-${segmentIndex}`}
        items={segment.items}
        isActive={isActive}
        summary={buildBatchSummary(segment.items, { toolById, thinkingSegments, t })}
        renderItem={(item, itemIndex) =>
          renderActivityItem(item, `${message.id}-batch-${segmentIndex}-${itemIndex}`)
        }
      />
    )
  }

  const rowClass = [
    'chat-bubble-row',
    'chat-bubble-row--assistant',
    enter ? 'chat-bubble-row--enter' : '',
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
        aria-label={t('bubble.assistantReply')}
        aria-live={streaming ? 'polite' : undefined}
        aria-busy={streaming ? true : undefined}
      >
        {activityTimeline.length > 0 ? (
          <div className="chat-activity-track">
            {activitySegments.map((segment, i) => renderActivitySegment(segment, i))}
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
                  formatToolLabel(message.toolUse.toolName, message.toolUse.parameters, t)
                }
              >
                {formatToolLabel(message.toolUse.toolName, message.toolUse.parameters, t)}
              </span>
            </div>
          </div>
        ) : null}

        {failed ? (
          <div className="chat-message-error" role="alert">
            <span className="chat-message-error__text">{t('bubble.retryFailedMessage')}</span>
            {onRetry ? (
              <button type="button" className="chat-message-error__retry" onClick={onRetry}>
                {t('bubble.retry')}
              </button>
            ) : null}
          </div>
        ) : null}

        <MessageMeta
          message={message}
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
  prev.enter === next.enter &&
  prev.focusToolUseId === next.focusToolUseId &&
  prev.toolsInteractive === next.toolsInteractive &&
  prev.onOpenFile === next.onOpenFile &&
  prev.wikiRootPath === next.wikiRootPath &&
  prev.showArchiveToWiki === next.showArchiveToWiki &&
  prev.onArchiveToWiki === next.onArchiveToWiki &&
  prev.onRetry === next.onRetry &&
  prev.onCancelQueued === next.onCancelQueued
)
