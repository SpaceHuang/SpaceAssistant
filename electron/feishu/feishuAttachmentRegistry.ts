import path from 'path'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import type { ExternalMessageAttachment } from '../../src/shared/domainTypes'

export const MAX_FEISHU_ATTACHMENT_BYTES = 32 * 1024 * 1024

export type RegisteredFeishuAttachment = {
  id: string
  messageId: string
  localPath: string
  kind: 'image' | 'file'
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
      kind: attachment.kind,
      ...(attachment.fileName ? { fileName: path.basename(attachment.fileName) } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {})
    }]
  })
}

/** Session messages retain only display metadata. Tool dispatch keeps the local path request-scoped. */
export function feishuMessageAttachments(message: FeishuInboundMessage): ExternalMessageAttachment[] {
  return registerInboundFeishuAttachments(message).map(({ id, kind, fileName, mimeType }) => ({
    id, source: 'feishu', kind, fileName: fileName ?? (kind === 'image' ? 'image' : 'file'), ...(mimeType ? { mimeType } : {})
  }))
}

export function findRegisteredFeishuAttachment(
  attachments: readonly RegisteredFeishuAttachment[] | undefined,
  id: unknown
): RegisteredFeishuAttachment | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return attachments?.find((attachment) => attachment.id === id)
}
