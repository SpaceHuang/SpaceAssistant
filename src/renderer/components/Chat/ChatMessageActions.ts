import type { ToolConfirmOptions } from '../../../shared/toolConfirm'

/** 列表级稳定操作入口；气泡内部再绑定 message.id / content。 */
export type ChatMessageActions = {
  archiveToWiki: (content: string) => void
  retryAssistant: (messageId: string) => void
  cancelQueued: (messageId: string) => void
  confirmTool: (toolUseId: string, approved: boolean, options?: ToolConfirmOptions) => void
  cancelTool: (toolUseId: string) => void
}
