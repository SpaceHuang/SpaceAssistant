import type { FeishuConfig, FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { readOwnerOpenIdFromAllowlist } from './feishuOwnerBind'

export function extractMentionsBot(raw: Record<string, unknown>): boolean {
  if (raw.mentions_bot === true) return true
  const mentions = raw.mentions
  if (Array.isArray(mentions)) {
    return mentions.some((m) => {
      if (!m || typeof m !== 'object') return false
      const rec = m as Record<string, unknown>
      if (rec.name === 'bot') return true
      const id = rec.id as { type?: string } | undefined
      return id?.type === 'app'
    })
  }
  return false
}

function parseTextContent(rawContent: unknown): string {
  if (typeof rawContent === 'string') {
    const trimmed = rawContent.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
          const text = (parsed as { text: string }).text
          return text || extractPostText(parsed) || text
        }
        return extractPostText(parsed)
      } catch {
        /* keep raw */
      }
    }
    return rawContent
  }
  if (rawContent && typeof rawContent === 'object') {
    const t = (rawContent as { text?: string }).text
    if (typeof t === 'string') return t
    return extractPostText(rawContent)
  }
  return ''
}

function extractPostText(value: unknown): string {
  const chunks: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if ((record.tag === 'text' || record.tag === 'md') && typeof record.text === 'string') {
      chunks.push(record.text)
      return
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'content' || key === 'title') visit(child)
    }
  }
  visit(value)
  return chunks.join('')
}

function parseInboundAttachments(value: unknown): FeishuInboundMessage['attachments'] {
  if (!Array.isArray(value)) return undefined
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    const localPath = typeof raw.localPath === 'string' ? raw.localPath : typeof raw.local_path === 'string' ? raw.local_path : ''
    const kind: 'file' | 'image' | undefined = raw.kind === 'file' || raw.type === 'file' ? 'file' : raw.kind === 'image' || raw.type === 'image' ? 'image' : undefined
    if (!localPath || !kind) return []
    return [{
      kind,
      localPath,
      ...(typeof raw.fileName === 'string' ? { fileName: raw.fileName } : typeof raw.file_name === 'string' ? { fileName: raw.file_name } : {}),
      ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : typeof raw.mime_type === 'string' ? { mimeType: raw.mime_type } : {})
    }]
  })
  return attachments.length ? attachments : undefined
}

export function parseCompactInboundEvent(raw: unknown): FeishuInboundMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const messageId = String(r.message_id ?? r.messageId ?? r.id ?? '')
  const chatId = String(r.chat_id ?? r.chatId ?? '')
  if (!messageId || !chatId) return null

  const rawContent = r.content
  const content = parseTextContent(rawContent)
  const msgType = typeof r.message_type === 'string'
    ? r.message_type
    : typeof r.msg_type === 'string'
      ? r.msg_type
      : typeof r.msgType === 'string'
        ? r.msgType
        : 'text'

  return {
    messageId,
    chatId,
    chatType: String(r.chat_type ?? r.chatType ?? 'p2p'),
    senderOpenId: String(r.sender_id ?? r.sender_open_id ?? r.senderOpenId ?? ''),
    senderName: typeof r.sender_name === 'string' ? r.sender_name : undefined,
    content,
    rawContent: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? ''),
    createTime: String(r.create_time ?? r.createTime ?? Date.now()),
    mentionsBot: extractMentionsBot(r),
    msgType,
    attachments: parseInboundAttachments(r.attachments)
  }
}

export function stripCommandPrefix(content: string, prefix: string): string {
  if (!prefix || !content.startsWith(prefix)) return content
  return content.slice(prefix.length).trim()
}

export interface InboundAcceptResult {
  accept: boolean
  reason?: string
  userMessage?: string
}

export type ShouldAcceptInboundOptions = {
  /** True while Feishu owner bind window is open. */
  bindingActive?: boolean
}

/**
 * P2P only. Group chats are always rejected (remoteGroupTrigger ignored).
 * Owner / bind checks: binding window accepts any p2p for bind; otherwise require owner match.
 */
export function shouldAcceptInbound(
  msg: FeishuInboundMessage,
  config: FeishuConfig,
  options?: ShouldAcceptInboundOptions
): InboundAcceptResult {
  if (!msg.content.trim()) return { accept: false, reason: 'empty' }
  if (msg.content.length > 4000) return { accept: false, reason: 'too_long' }

  if (msg.chatType === 'group') {
    return { accept: false, reason: 'group_disabled' }
  }

  if (msg.chatType !== 'p2p') {
    return { accept: false, reason: 'unsupported_chat_type' }
  }

  if (options?.bindingActive) {
    return { accept: true, reason: 'bind_window', userMessage: msg.content.trim() }
  }

  const owner = readOwnerOpenIdFromAllowlist(config.remoteSenderAllowlist)
  if (!owner) {
    return { accept: false, reason: 'unbound' }
  }
  if (msg.senderOpenId !== owner) {
    return { accept: false, reason: 'non_owner' }
  }

  return { accept: true, userMessage: msg.content.trim() }
}
