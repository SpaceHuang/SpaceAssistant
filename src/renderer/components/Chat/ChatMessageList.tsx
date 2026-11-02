import { useMemo } from 'react'
import type { Message, ShellConfig } from '../../../shared/domainTypes'
import type { ToolsInteractiveScalars } from '../../services/resolveMessageToolsInteractive'
import { useChatSearchActiveTarget } from '../Search/SearchProvider'
import { ChatBubble, type ToolsInteractiveProps } from './ChatBubble'
import type { ChatMessageActions } from './ChatMessageActions'
import type { PendingConfirmItem } from '../../services/pendingConfirmStore'
import { restorePendingConfirmToolCalls } from '../../services/resolveMessageToolsInteractive'
import { useTurnDisplay, useTurnDisplays } from '../../hooks/useTurnDisplay'
import { buildAssistantActivityTimeline } from '../../../shared/assistantActivityTimeline'
import type { ActivityDisplayItem } from '../../../shared/turnDisplayProtocol'
import { NO_CONTENT_MESSAGE } from '../../../shared/toolResultPairing'
import { settleTerminalToolCallsForDisplay } from '../../services/terminalToolCallDisplay'

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
  retryOfMessageIdByAssistant?: Record<string, string>
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
  retryOfMessageIdByAssistant,
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
  // Abort clears runningSessions before the canonical checkpoint is read. The row can therefore
  // lose its turnId while the display store still owns the only copy of the in-flight tool steps.
  const turnDisplays = useTurnDisplays()
  const restoredMessages = useMemo(
    () => restorePendingConfirmToolCalls(messages, pendingConfirmItems).map(settleTerminalToolCallsForDisplay),
    [messages, pendingConfirmItems]
  )

  return (
    <>
      {restoredMessages.map((m) => {
        const display = activeDisplay?.message.id === m.id
          ? activeDisplay
          : turnDisplays
            .filter((candidate) => candidate.message.id === m.id)
            .sort((a, b) => b.version - a.version)[0]
        const rowTurnId = display?.turnId
        // Cancellation can update the persisted message before the terminal turn-display event arrives.
        // Keep the matching live projection visible throughout that handoff window.
        const terminalDisplay = m.status === 'cancelled' || m.status === 'failed'
        const useDisplay = Boolean(display && (m.status === 'streaming' || terminalDisplay))
        const suppressEmptyAssistantPlaceholder = Boolean(terminalDisplay && display && (
          display.message.content === NO_CONTENT_MESSAGE || (!display.message.content && m.content === NO_CONTENT_MESSAGE)
        ))
        const displayContent = display && suppressEmptyAssistantPlaceholder ? '' : display?.message.content
        const mergedToolCalls = display && useDisplay
          ? (() => {
              const calls = [...(m.toolCalls ?? [])]
              const existingIds = new Set(calls.map((tool) => tool.id))
              for (const live of display.message.toolCalls) {
                if (!existingIds.has(live.id)) {
                  calls.push({ id: live.id, toolName: live.toolName, input: {}, status: live.status, riskLevel: live.display.confirmRisk })
                  existingIds.add(live.id)
                }
              }
              return calls
            })()
          : undefined
        const boundedMessage = display && useDisplay
          ? { ...m, status: m.status === 'streaming' && display.lifecycle === 'completed' ? 'completed' as const : m.status === 'streaming' && display.lifecycle === 'failed' ? 'failed' as const : m.status, content: displayContent ?? display.message.content, contentSegments: suppressEmptyAssistantPlaceholder ? [] : display.message.contentSegments.map((segment) => ({ content: display.message.content.slice(segment.start, segment.end), startTime: m.timestamp, endTime: display.lifecycle === 'completed' || display.lifecycle === 'failed' ? m.timestamp : undefined })), thinking: display.message.thinking, skillHints: display.message.skillHints, systemOperations: display.message.systemOperations, toolCalls: mergedToolCalls!.map((tool) => {
              const summary = display.message.toolCalls.find((candidate) => candidate.id === tool.id)?.display
              let input: Record<string, unknown> = tool.input
              try { if (summary?.inputPreview) { const parsed = JSON.parse(summary.inputPreview); if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown> } } catch { /* 保留 canonical input */ }
              const live = display.message.toolCalls.find((candidate) => candidate.id === tool.id)
              return {
                ...tool,
                input,
                status: terminalDisplay && live && (live.status === 'calling' || live.status === 'confirming' || live.status === 'executing')
                  ? 'failed' as const : live?.status ?? tool.status,
                ...(terminalDisplay && live && (live.status === 'calling' || live.status === 'confirming' || live.status === 'executing') ? { interrupted: true } : {}),
                // §5.8 显式赋值：canonical 记录可能残留 agent 阶段的 autoAnswerer:true（恢复/合并路径），
                // 投影层已显式给出 false 时必须覆盖，否则合并后卡片仍是只读态
                ...(live?.display.autoAnswerer !== undefined ? { autoAnswerer: live.display.autoAnswerer } : {}),
                ...(live?.display.remoteConfirmation ? { remoteConfirmation: live.display.remoteConfirmation } : {}),
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
        const missingCanonicalToolActivity = Boolean(display && boundedMessage.toolCalls?.some((tool) =>
          !display.message.activity.some((entry) => entry.kind === 'tool' && entry.toolId === tool.id)
        ))
        const rebuildCanonicalActivity = () => buildAssistantActivityTimeline(boundedMessage).map((item): ActivityDisplayItem => {
          if (item.kind !== 'text') return item
          const existing = display?.message.activity.find((entry) => entry.kind === 'text' && entry.segmentIndex === item.segmentIndex)
          const segment = display?.message.contentSegments.find((entry) => entry.segmentIndex === item.segmentIndex)
          return {
            ...item,
            contentStart: existing?.kind === 'text' ? existing.contentStart : segment?.start ?? 0,
            contentEnd: existing?.kind === 'text' ? existing.contentEnd : segment?.end ?? 0
          }
        })
        const displayActivity: ActivityDisplayItem[] | undefined = display && (m.status === 'streaming' || display.message.id === m.id)
          ? missingCanonicalToolActivity
            ? rebuildCanonicalActivity()
            : missingPendingActivityItems.length === 0
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
              : rebuildCanonicalActivity()
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
            displayToolSummaries={display && useDisplay ? Object.fromEntries(display.message.toolCalls.map((tool) => [tool.id, tool.display])) : undefined}
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
            {...(retryOfMessageIdByAssistant?.[m.id] ? { retryOfMessageId: retryOfMessageIdByAssistant[m.id] } : {})}
            onOpenModelSettings={onOpenModelSettings}
            onRenderProbe={onBubbleRender}
            activeSearchTarget={activeTarget?.messageId === m.id ? activeTarget : null}
          />
        )
      })}
    </>
  )
}
