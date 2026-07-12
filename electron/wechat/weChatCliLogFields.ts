import type { WeChatInboundMessage } from '../../src/shared/wechatTypes'

export const WECHAT_CLI_PREVIEW_MAX = 4 * 1024

export function contentHash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return Math.abs(h).toString(16).padStart(8, '0').slice(0, 8)
}

export function previewText(text: string, maxLen = WECHAT_CLI_PREVIEW_MAX): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen)
}

export function qrUrlHostOnly(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return undefined
  }
}

export function inboundSummaryForLog(msg: WeChatInboundMessage): Record<string, unknown> {
  const text = msg.text ?? ''
  return {
    messageId: msg.messageId,
    userId: msg.userId,
    type: msg.type,
    timestamp: msg.timestamp,
    textLen: text.length,
    textHash: contentHash(text),
    hasQuoted: Boolean(msg.quotedMessage?.text),
    attachmentCounts: {
      images: msg.images?.length ?? 0,
      files: msg.files?.length ?? 0,
      voices: msg.voices?.length ?? 0,
      videos: msg.videos?.length ?? 0
    }
  }
}

export function preprocessWeChatCliFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields }

  if (typeof out.text === 'string') {
    out.textLen = out.text.length
    out.textHash = contentHash(out.text)
    delete out.text
  }
  if (typeof out.content === 'string') {
    out.contentLen = out.content.length
    out.contentHash = contentHash(out.content)
    delete out.content
  }
  if (typeof out.summary === 'string') {
    out.summaryLen = out.summary.length
    out.summaryHash = contentHash(out.summary)
    delete out.summary
  }
  if (typeof out.qrUrl === 'string') {
    out.qrUrlHost = qrUrlHostOnly(out.qrUrl)
    delete out.qrUrl
  }
  if (typeof out.token === 'string') {
    delete out.token
  }

  return out
}
