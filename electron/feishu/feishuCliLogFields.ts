import path from 'path'
import type { FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { redactLarkCliArgsForDisplay } from './larkCliSecurity'

export const FEISHU_CLI_PREVIEW_MAX = 4 * 1024
export const FEISHU_CLI_LINE_PREVIEW_MAX = 500

export function contentHash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return Math.abs(h).toString(16).padStart(8, '0').slice(0, 8)
}

export function previewText(text: string, maxLen = FEISHU_CLI_PREVIEW_MAX): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen)
}

export function authUrlHostOnly(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return undefined
  }
}

export function redactLarkCliArgsForLog(args: string[]): {
  argsRedacted: string
  dataLen?: number
  dataHash?: string
} {
  const parts: string[] = []
  let dataLen: number | undefined
  let dataHash: string | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const prev = i > 0 ? args[i - 1] : ''
    if (prev === '--secret' || /--token/i.test(prev) || /--secret/i.test(a)) {
      parts.push('***')
      continue
    }
    if (prev === '--data') {
      dataLen = a.length
      dataHash = contentHash(a)
      parts.push(`--data <len=${dataLen} hash=${dataHash}>`)
      continue
    }
    parts.push(a)
  }

  const joined = `lark-cli ${parts.join(' ')}`
  const argsRedacted = joined.length > 200 ? `${joined.slice(0, 200)}…` : joined
  return { argsRedacted, dataLen, dataHash }
}

export function inboundSummaryForLog(msg: FeishuInboundMessage): Record<string, unknown> {
  const content = msg.content ?? ''
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderOpenId: msg.senderOpenId,
    msgType: msg.msgType,
    mentionsBot: msg.mentionsBot,
    createTime: msg.createTime,
    contentLen: content.length,
    contentHash: contentHash(content),
    attachments: msg.attachments?.map((a) => ({
      kind: a.kind,
      fileName: a.fileName,
      mimeType: a.mimeType,
      localPathBasename: a.localPath ? path.basename(a.localPath) : undefined
    }))
  }
}

export function preprocessFeishuCliFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields }

  if (typeof out.content === 'string') {
    out.contentLen = out.content.length
    out.contentHash = contentHash(out.content)
    delete out.content
  }
  if (typeof out.rawContent === 'string') {
    delete out.rawContent
  }

  if (Array.isArray(out.args)) {
    const redacted = redactLarkCliArgsForLog(out.args as string[])
    out.argsRedacted = redacted.argsRedacted
    if (redacted.dataLen !== undefined) out.dataLen = redacted.dataLen
    if (redacted.dataHash !== undefined) out.dataHash = redacted.dataHash
    delete out.args
  }

  if (typeof out.stdout === 'string') {
    out.stdoutLen = out.stdout.length
    out.stdoutPreview = previewText(out.stdout)
    delete out.stdout
  }
  if (typeof out.stderr === 'string') {
    out.stderrLen = out.stderr.length
    out.stderrPreview = previewText(out.stderr)
    delete out.stderr
  }

  if (typeof out.authUrl === 'string') {
    out.authUrlHost = authUrlHostOnly(out.authUrl)
    delete out.authUrl
  }

  return out
}
