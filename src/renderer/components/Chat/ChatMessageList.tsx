import type { Message, ShellConfig } from '../../../shared/domainTypes'
import type { ToolsInteractiveScalars } from '../../services/resolveMessageToolsInteractive'
import { useChatSearchActiveTarget } from '../Search/SearchProvider'
import { ChatBubble, type ToolsInteractiveProps } from './ChatBubble'
import type { ChatMessageActions } from './ChatMessageActions'

export type ChatMessageListProps = {
  messages: Message[]
  enterMessageId?: string | null
  actions: ChatMessageActions
  resolveToolsInteractive: (message: Message) => ToolsInteractiveProps | ToolsInteractiveScalars | undefined
  showArchiveToWiki: (message: Message) => boolean
  canRetry: (message: Message) => boolean
  canCancelQueued: (message: Message) => boolean
  focusToolUseId?: string | null
  workDir?: string
  shellConfig?: ShellConfig
  sessionMetadata?: Record<string, unknown>
  onOpenFile?: (relPath: string) => void
  wikiRootPath?: string
  /** 仅测试：在气泡实际 render 时回调 */
  onBubbleRender?: (messageId: string) => void
}

/**
 * 消息列表薄层：向每个气泡传递同一份稳定 actions，行级交互标量按消息计算。
 */
export function ChatMessageList({
  messages,
  enterMessageId,
  actions,
  resolveToolsInteractive,
  showArchiveToWiki,
  canRetry,
  canCancelQueued,
  focusToolUseId,
  workDir,
  shellConfig,
  sessionMetadata,
  onOpenFile,
  wikiRootPath,
  onBubbleRender
}: ChatMessageListProps) {
  const activeTarget = useChatSearchActiveTarget()

  return (
    <>
      {messages.map((m) => {
        const toolsInteractive = resolveToolsInteractive(m)
        const rowFocus =
          focusToolUseId &&
          m.toolCalls?.some((tc) => tc.id === focusToolUseId && tc.status === 'confirming')
            ? focusToolUseId
            : undefined

        return (
          <ChatBubble
            key={m.id}
            message={m}
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
            onRenderProbe={onBubbleRender}
            activeSearchTarget={activeTarget?.messageId === m.id ? activeTarget : null}
          />
        )
      })}
    </>
  )
}
