import type { AppDatabase } from '../database'
import {
  formatRemoteOutboundMessage,
  sessionSuffixLength as defaultSessionSuffixLength
} from '../../src/shared/remoteOutboundFormat'
import { touchRemoteSessionActivity } from './remoteSessionActivity'

export function maybeTouchOutboundActivity(
  sessionId: string | undefined,
  touch?: { db: AppDatabase; sessionId: string }
): void {
  if (sessionId && touch) {
    touchRemoteSessionActivity(touch.db, touch.sessionId)
  }
}

/** Simple maxLen truncation (Feishu-style). Leaves WeChat paragraph-aware path in platform code. */
export function buildSimpleOutboundText(args: {
  body: string
  sessionId?: string
  maxLen: number
  truncationSuffix: string
  formatSummary?: (raw: string) => string
  formatWithSession?: (body: string, sessionId: string) => string
  sessionSuffixLength?: (sessionId: string) => number
}): string {
  const {
    sessionId,
    maxLen,
    truncationSuffix,
    formatSummary,
    formatWithSession = formatRemoteOutboundMessage,
    sessionSuffixLength: suffixLenFn = defaultSessionSuffixLength
  } = args
  const body = formatSummary ? formatSummary(args.body) : args.body

  if (sessionId) {
    const suffixLen = suffixLenFn(sessionId)
    const maxBody = maxLen - suffixLen
    let truncatedBody = body
    if (body.length > maxBody) {
      const cut = Math.max(0, maxBody - truncationSuffix.length)
      truncatedBody = `${body.slice(0, cut)}${truncationSuffix}`
    }
    return formatWithSession(truncatedBody, sessionId)
  }

  return body.length > maxLen
    ? `${body.slice(0, Math.max(0, maxLen - truncationSuffix.length))}${truncationSuffix}`
    : body
}

export async function sendImOutbound(args: {
  reply: (text: string) => Promise<void>
  body: string
  sessionId?: string
  maxLen: number
  truncationSuffix: string
  formatSummary?: (raw: string) => string
  formatWithSession?: (body: string, sessionId: string) => string
  sessionSuffixLength?: (sessionId: string) => number
  touch?: { db: AppDatabase; sessionId: string }
}): Promise<void> {
  const text = buildSimpleOutboundText(args)
  await args.reply(text)
  maybeTouchOutboundActivity(args.sessionId, args.touch)
}
