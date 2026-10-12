import type { WeChatInboundMessage } from '../../src/shared/wechatTypes'
import { contentHash, previewText, urlHostOnly } from '../remote/imCliLogFields'

export { contentHash, previewText }
export const WECHAT_CLI_PREVIEW_MAX = 4 * 1024
/** 单行日志里 error/message 摘要的截断上限（对齐飞书侧 FEISHU_CLI_LINE_PREVIEW_MAX）。 */
export const WECHAT_CLI_LINE_PREVIEW_MAX = 500

export function qrUrlHostOnly(url: string | undefined): string | undefined {
  return urlHostOnly(url)
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
    hasQuoted: Boolean(msg.quotedMessageText ?? msg.quotedMessage?.text),
    quotedMessageIdPresent: Boolean(msg.quotedMessageId),
    quotedMessageTextLen: (msg.quotedMessageText ?? msg.quotedMessage?.text)?.length ?? 0,
    attachmentCounts: {
      images: msg.images?.length ?? 0,
      files: msg.files?.length ?? 0,
      voices: msg.voices?.length ?? 0,
      videos: msg.videos?.length ?? 0
    }
  }
}

/** Redacted comparison between iLink's raw ref_msg and the SDK quote projection. */
export function quoteWireSummaryForLog(
  raw: { item_list?: Array<{ ref_msg?: { message_item?: { text_item?: { text?: unknown } } } }> } | undefined,
  sdkQuote: { text?: string } | undefined
): Record<string, unknown> {
  const ref = raw?.item_list?.map((item) => item.ref_msg).find((item) => item !== undefined)
  const messageItem = ref?.message_item
  const textItem = messageItem?.text_item
  const rawText = ref?.message_item?.text_item?.text
  const sdkText = sdkQuote?.text
  const messageItemRecord = messageItem && typeof messageItem === 'object' ? messageItem as Record<string, unknown> : undefined
  const rawQuoteMessageId = messageItemRecord?.msg_id
  const payloadKinds = ['text_item', 'image_item', 'voice_item', 'file_item', 'video_item', 'ref_msg']
    .filter((key) => messageItemRecord?.[key] !== undefined)
  const rawTextIsString = typeof rawText === 'string'
  const sdkTextIsString = typeof sdkText === 'string'
  return {
    rawRefMessagePresent: ref !== undefined,
    rawRefMessageItemPresent: messageItem !== undefined,
    rawRefMessageItemType: typeof messageItemRecord?.type === 'number' ? messageItemRecord.type : undefined,
    rawQuoteMessageIdType: rawQuoteMessageId === null ? 'null' : typeof rawQuoteMessageId,
    rawQuoteMessageIdLen: typeof rawQuoteMessageId === 'string' || typeof rawQuoteMessageId === 'number' ? String(rawQuoteMessageId).length : 0,
    rawQuoteMessageIdHash: typeof rawQuoteMessageId === 'string' || typeof rawQuoteMessageId === 'number' ? contentHash(String(rawQuoteMessageId)) : undefined,
    rawRefMessageItemKeys: messageItemRecord ? Object.keys(messageItemRecord).sort() : [],
    rawRefMessagePayloadKinds: payloadKinds,
    rawTextItemPresent: textItem !== undefined,
    rawTextValueType: rawText === null ? 'null' : typeof rawText,
    rawRefTitlePresent: typeof (ref as { title?: unknown } | undefined)?.title === 'string',
    rawQuotedTextLen: rawTextIsString ? rawText.length : 0,
    sdkQuotedTextPresent: sdkTextIsString,
    sdkQuotedTextLen: sdkTextIsString ? sdkText.length : 0,
    quoteTextProjectionMatches: ref === undefined
      ? !sdkTextIsString
      : rawTextIsString && sdkTextIsString && rawText === sdkText
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
