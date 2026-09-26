import path from 'path'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'

export const MAX_FEISHU_ATTACHMENT_BYTES = 32 * 1024 * 1024

export type RegisteredFeishuAttachment = {
  id: string
  messageId: string
  localPath: string
  fileName?: string
  mimeType?: string
}

/** 生成只在这条入站消息请求内有效的附件编号；磁盘路径不会进入模型工具参数。 */
export function registerInboundFeishuAttachments(message: FeishuInboundMessage): RegisteredFeishuAttachment[] {
  return (message.attachments ?? []).flatMap((attachment, index) => {
    const localPath = typeof attachment.localPath === 'string' ? attachment.localPath.trim() : ''
    if (!localPath || (!path.isAbsolute(localPath) && !path.win32.isAbsolute(localPath))) return []
    return [{
      id: `attachment-${index + 1}`,
      messageId: message.messageId,
      localPath,
      ...(attachment.fileName ? { fileName: path.basename(attachment.fileName) } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {})
    }]
  })
}

export function findRegisteredFeishuAttachment(
  attachments: readonly RegisteredFeishuAttachment[] | undefined,
  id: unknown
): RegisteredFeishuAttachment | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return attachments?.find((attachment) => attachment.id === id)
}
