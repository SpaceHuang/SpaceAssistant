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
  batchContainsConfirmingTool,
  isActivityBatchInProgress,
  type ActivityTrackSegment
} from '../../../shared/activityBatchGrouping'
import { contentSegmentsForRender } from '../../../shared/contentSegments'
import { thinkingSegmentsForRender } from '../../../shared/thinkingSegments'
import { buildFragmentId } from '../../../shared/chatSearchFragments'
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
import type { ToolConfirmOptions } from '../../../shared/toolConfirm'
import type { ChatMessageActions } from './ChatMessageActions'
import type { ToolsInteractiveScalars } from '../../services/resolveMessageToolsInteractive'
import type { ChatSearchActiveTarget } from '../../services/chatSearchActiveTarget'

/** @deprecated 使用 ToolsInteractiveScalars；保留别名兼容旧导入 */
export type ToolsInteractiveProps = ToolsInteractiveScalars & {
  onToolConfirm?: (toolUseId: string, approved: boolean, options?: ToolConfirmOptions) => void
  onToolCancel?: (toolUseId: string) => void
}

type Props = {
  message: Message
  /** 新追加的消息行入场动效（由 ChatView 按条数增量判定） */
  enter?: boolean
  /** 工具交互标量；confirm/cancel 优先用 override，否则用 actions */
  toolsInteractive?: ToolsInteractiveProps
  focusToolUseId?: string | null
  workDir?: string
  shellConfig?: ShellConfig
  sessionMetadata?: Record<string, unknown>
  onOpenFile?: (relPath: string) => void
  wikiRootPath?: string
  showArchiveToWiki?: boolean
  showRetry?: boolean
  showCancelQueued?: boolean
  actions?: ChatMessageActions
  /** 仅测试：气泡实际进入 render 时回调 */
  onRenderProbe?: (messageId: string) => void
  /** 当前搜索命中目标（仅目标消息传入） */
  activeSearchTarget?: ChatSearchActiveTarget | null
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
  wikiRootPath,
  messageId,
  segmentIndex,
  activeSearchTarget
}: {
  activeText: boolean
  body: string
  onOpenFile?: (relPath: string) => void
  wikiRootPath?: string
  messageId: string
  segmentIndex: number
  activeSearchTarget?: ChatSearchActiveTarget | null
}) {
  if (activeText) {
    return <div className="chat-stream-plain chat-md-assistant">{body}</div>
  }
  return (
    <ChatMarkdown
      content={body}
      onOpenFile={onOpenFile}
      wikiRootPath={wikiRootPath}
      messageId={messageId}
      segmentIndex={segmentIndex}
      activeSearchTarget={activeSearchTarget}
    />
  )
}

function MessageMeta({
  message,
  streaming,
  failed,
  queued = false,
  showCancelQueued,
  onCancelQueued,
  showArchiveToWiki,
  onArchiveToWiki
}: {
  message: Message
  streaming: boolean
  failed: boolean
  queued?: boolean
  showCancelQueued?: boolean
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
      {queued && showCancelQueued && onCancelQueued ? (
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
  showRetry = false,
  showCancelQueued = false,
  actions,
  onRenderProbe,
  activeSearchTarget = null
}: Props) {
  onRenderProbe?.(message.id)
  const { t } = useTypedTranslation('chat')
  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'
  const failed = message.status === 'failed'
  const searchRevealPath = activeSearchTarget?.revealPath

  const activityModel = useMemo(() => {
    const thinkingSegments = message.thinking ? thinkingSegmentsForRender(message.thinking) : []
    const textSegments = contentSegmentsForRender(message)
    const toolById = new Map((message.toolCalls ?? []).map((tc) => [tc.id, tc]))
    const skillById = new Map((message.skillHints ?? []).map((h) => [h.id, h]))
    const timeline =
      message.role !== 'user' && message.role !== 'system'
        ? buildAssistantActivityTimeline(message)
        : []
    const getTimestamp = buildActivityItemTimestampResolver(message)
    return {
      thinkingSegments,
      textSegments,
      toolById,
      skillById,
      activityTimeline: timeline,
      segments: groupActivityTimeline(timeline, getTimestamp)
    }
  }, [
    message.thinking,
    message.content,
    message.contentSegments,
    message.toolCalls,
    message.skillHints,
    message.role,
    message.timestamp,
    message.id,
    message.sessionId,
    message.status
  ])

  const {
    thinkingSegments,
    textSegments,
    toolById,
    skillById,
    activityTimeline,
    segments: activitySegments
  } = activityModel

  const batchProgressCtx = useMemo(
    () => ({ streaming, thinkingSegments, toolById }),
    [streaming, thinkingSegments, toolById]
  )

  const handleArchiveToWiki = actions
    ? () => actions.archiveToWiki(message.content)
    : undefined
  const handleRetry = actions ? () => actions.retryAssistant(message.id) : undefined
  const handleCancelQueued = actions ? () => actions.cancelQueued(message.id) : undefined
  const confirmTool =
    toolsInteractive?.onToolConfirm ?? (actions ? actions.confirmTool : undefined)
  const cancelTool = toolsInteractive?.onToolCancel ?? (actions ? actions.cancelTool : undefined)

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
            <div
              className="chat-md-user"
              data-search-fragment-id={buildFragmentId(message.id, { kind: 'user-content' })}
            >
              {message.content}
            </div>
          </div>
          <MessageMeta
            message={message}
            streaming={false}
            failed={false}
            queued={message.status === 'queued'}
            showCancelQueued={showCancelQueued}
            onCancelQueued={handleCancelQueued}
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
          messageId={message.id}
          segmentIndex={item.segmentIndex}
          activeSearchTarget={activeSearchTarget}
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
            messageId={message.id}
            segmentIndex={item.segmentIndex}
            activeSearchTarget={activeSearchTarget}
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
    const toolsLive = Boolean(toolsInteractive && (confirmTool || cancelTool))
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
          toolsLive && confirmTool && tc.status === 'confirming'
            ? (approved, options) => confirmTool(tc.id, approved, options)
            : undefined
        }
        onCancel={
          toolsLive && cancelTool && tc.status === 'executing'
            ? () => cancelTool(tc.id)
            : undefined
        }
        onOpenFile={onOpenFile}
        activeSearchTarget={
          activeSearchTarget?.revealPath?.toolUseId === tc.id ? activeSearchTarget : null
        }
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
    const keepExpanded = batchContainsConfirmingTool(segment.items, toolById)
    const searchReveal = Boolean(
      searchRevealPath &&
        segment.items.some((item) => {
          if (searchRevealPath.thinkingSegmentIndex != null && item.kind === 'thinking') {
            return item.segmentIndex === searchRevealPath.thinkingSegmentIndex
          }
          if (searchRevealPath.toolUseId && item.kind === 'tool') {
            return item.toolId === searchRevealPath.toolUseId
          }
          return false
        })
    )

    return (
      <ActivityBatch
        key={`${message.id}-batch-${segmentIndex}`}
        items={segment.items}
        isActive={isActive}
        keepExpanded={keepExpanded}
        searchReveal={searchReveal}
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
            {showRetry && handleRetry ? (
              <button type="button" className="chat-message-error__retry" onClick={handleRetry}>
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
          onArchiveToWiki={handleArchiveToWiki}
        />
      </div>
    </div>
  )
}, (prev, next) =>
  prev.message === next.message &&
  prev.enter === next.enter &&
  prev.focusToolUseId === next.focusToolUseId &&
  prev.toolsInteractive?.requestId === next.toolsInteractive?.requestId &&
  prev.toolsInteractive?.confirmMode === next.toolsInteractive?.confirmMode &&
  prev.toolsInteractive?.onToolConfirm === next.toolsInteractive?.onToolConfirm &&
  prev.toolsInteractive?.onToolCancel === next.toolsInteractive?.onToolCancel &&
  prev.workDir === next.workDir &&
  prev.shellConfig === next.shellConfig &&
  prev.sessionMetadata === next.sessionMetadata &&
  prev.onOpenFile === next.onOpenFile &&
  prev.wikiRootPath === next.wikiRootPath &&
  prev.showArchiveToWiki === next.showArchiveToWiki &&
  prev.showRetry === next.showRetry &&
  prev.showCancelQueued === next.showCancelQueued &&
  prev.actions === next.actions &&
  prev.onRenderProbe === next.onRenderProbe &&
  prev.activeSearchTarget === next.activeSearchTarget
)
