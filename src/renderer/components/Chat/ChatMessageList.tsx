import { useMemo } from 'react'
import type { Message, ShellConfig } from '../../../shared/domainTypes'
import type { ToolsInteractiveScalars } from '../../services/resolveMessageToolsInteractive'
import { useChatSearchActiveTarget } from '../Search/SearchProvider'
import { ChatBubble, type ToolsInteractiveProps } from './ChatBubble'
import type { ChatMessageActions } from './ChatMessageActions'
import type { PendingConfirmItem } from '../../services/pendingConfirmStore'
import { restorePendingConfirmToolCalls } from '../../services/resolveMessageToolsInteractive'
import { useTurnDisplay } from '../../hooks/useTurnDisplay'
import { buildAssistantActivityTimeline } from '../../../shared/assistantActivityTimeline'
import type { ActivityDisplayItem } from '../../../shared/turnDisplayProtocol'

/** 空确认映射常量：保证无确认项时行内 props 引用稳定（ChatBubble.memo 浅比较依赖）。 */
const EMPTY_CONFIRM_READY: Record<string, boolean | undefined> = {}

export type ChatMessageListProps = {
  messages: Message[]
  enterMessageId?: string | null
  actions: ChatMessageActions
  resolveToolsInteractive: (message: Message) => ToolsInteractiveProps | ToolsInteractiveScalars | undefined
  showArchiveToWiki: (message: Message) => boolean
  canRetry: (message: Message) => boolean
  canCancelQueued: (message: Message) => boolean
  /** 由 ChatView 按 sessionId 预分组的确认就绪映射；值三态透传（undefined 不归一为 false） */
  confirmationReadyBySession: Record<string, Record<string, boolean | undefined>>
  /** 解析该消息对应的真实失败原因（无则返回 undefined） */
  resolveFailureReason?: (message: Message) => string | undefined
  onOpenModelSettings?: () => void
  focusToolUseId?: string | null
  pendingConfirmItems?: PendingConfirmItem[]
  workDir?: string
  shellConfig?: ShellConfig
  sessionMetadata?: Record<string, unknown>
  onOpenFile?: (relPath: string) => void
  wikiRootPath?: string
  /** 仅测试：在气泡实际 render 时回调 */
  onBubbleRender?: (messageId: string) => void
  turnId?: string
}

/**
 * 消息列表薄层：向每个气泡传递同一份稳定 actions，行级交互标量按消息计算。
 */
export function ChatMessageList({
  messages,
  enterMessageId,
  actions,
  confirmationReadyBySession,
  resolveToolsInteractive,
  showArchiveToWiki,
  canRetry,
  canCancelQueued,
  resolveFailureReason,
  onOpenModelSettings,
  focusToolUseId,
  pendingConfirmItems = [],
  workDir,
  shellConfig,
  sessionMetadata,
  onOpenFile,
  wikiRootPath,
  onBubbleRender,
  turnId
}: ChatMessageListProps) {
  const activeTarget = useChatSearchActiveTarget()
  const activeDisplay = useTurnDisplay(turnId)
  const restoredMessages = useMemo(
    () => restorePendingConfirmToolCalls(messages, pendingConfirmItems),
    [messages, pendingConfirmItems]
  )

  return (
    <>
      {restoredMessages.map((m) => {
        const display = m.status === 'streaming' && activeDisplay?.message.id === m.id ? activeDisplay : undefined
        const rowTurnId = display?.turnId
        const boundedMessage = display && m.status === 'streaming'
          ? { ...m, status: display.lifecycle === 'completed' ? 'completed' as const : display.lifecycle === 'failed' ? 'failed' as const : m.status, content: display.message.content, contentSegments: display.message.contentSegments.map((segment) => ({ content: display.message.content.slice(segment.start, segment.end), startTime: m.timestamp, endTime: display.lifecycle === 'completed' || display.lifecycle === 'failed' ? m.timestamp : undefined })), thinking: display.message.thinking, skillHints: display.message.skillHints, toolCalls: (m.toolCalls?.length ? m.toolCalls : display.message.toolCalls.map((tool) => ({ id: tool.id, toolName: tool.toolName, input: {}, status: tool.status, riskLevel: tool.display.confirmRisk }))).map((tool) => {
              const summary = display.message.toolCalls.find((candidate) => candidate.id === tool.id)?.display
              let input: Record<string, unknown> = tool.input
              try { if (summary?.inputPreview) { const parsed = JSON.parse(summary.inputPreview); if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown> } } catch { /* 保留 canonical input */ }
              const live = display.message.toolCalls.find((candidate) => candidate.id === tool.id)
              return {
                ...tool,
                input,
                status: live?.status ?? tool.status,
                // §5.8 显式赋值：canonical 记录可能残留 agent 阶段的 autoAnswerer:true（恢复/合并路径），
                // 投影层已显式给出 false 时必须覆盖，否则合并后卡片仍是只读态
                ...(live?.display.autoAnswerer !== undefined ? { autoAnswerer: live.display.autoAnswerer } : {}),
                ...(live?.display.progressPreview ? { progressOutput: live.display.progressPreview } : {})
              }
            }) }
          : m
        const toolsInteractive = resolveToolsInteractive(boundedMessage)
        const missingPendingActivityItems = display ? pendingConfirmItems.filter((item) =>
          item.sessionId === m.sessionId &&
          boundedMessage.toolCalls?.some((tool) => tool.id === item.toolUseId) &&
          !display.message.activity.some((entry) => entry.kind === 'tool' && entry.toolId === item.toolUseId)
        ) : []
        const displayActivity: ActivityDisplayItem[] | undefined = display && (m.status === 'streaming' || display.message.id === m.id)
          ? missingPendingActivityItems.length === 0
            ? display.message.activity
            : missingPendingActivityItems.every((item) => item.activityIndex !== undefined)
              ? (() => {
                  const activity = [...display.message.activity]
                  for (const item of [...missingPendingActivityItems].sort((a, b) => b.activityIndex! - a.activityIndex!)) {
                    const index = Math.max(0, Math.min(item.activityIndex!, activity.length))
                    activity.splice(index, 0, { kind: 'tool', toolId: item.toolUseId })
                  }
                  return activity
                })()
              : buildAssistantActivityTimeline(boundedMessage).map((item): ActivityDisplayItem => {
                  if (item.kind !== 'text') return item
                  const existing = display.message.activity.find((entry) => entry.kind === 'text' && entry.segmentIndex === item.segmentIndex)
                  return {
                    ...item,
                    contentStart: existing?.kind === 'text' ? existing.contentStart : 0,
                    contentEnd: existing?.kind === 'text' ? existing.contentEnd : 0
                  }
                })
          : undefined
        const rowFocus =
          focusToolUseId &&
          m.toolCalls?.some((tc) => tc.id === focusToolUseId && tc.status === 'confirming')
            ? focusToolUseId
            : undefined

        return (
        <ChatBubble
            key={m.id}
            message={boundedMessage}
            turnId={rowTurnId}
            displayActivity={displayActivity}
            displayToolSummaries={display && (m.status === 'streaming' || display.message.id === m.id) ? Object.fromEntries(display.message.toolCalls.map((tool) => [tool.id, tool.display])) : undefined}
            confirmationReadyByToolId={confirmationReadyBySession[m.sessionId] ?? EMPTY_CONFIRM_READY}
            enter={m.id === enterMessageId}
            actions={actions}
            toolsInteractive={toolsInteractive}
            focusToolUseId={rowFocus}
            workDir={workDir}
            shellConfig={shellConfig}
            sessionMetadata={sessionMetadata}
            onOpenFile={onOpenFile}
            wikiRootPath={wikiRootPath}
            showArchiveToWiki={showArchiveToWiki(m)}
            showRetry={canRetry(m)}
            showCancelQueued={canCancelQueued(m)}
            {...(resolveFailureReason ? { failureReason: resolveFailureReason(m) } : {})}
            onOpenModelSettings={onOpenModelSettings}
            onRenderProbe={onBubbleRender}
            activeSearchTarget={activeTarget?.messageId === m.id ? activeTarget : null}
          />
        )
      })}
    </>
  )
}
