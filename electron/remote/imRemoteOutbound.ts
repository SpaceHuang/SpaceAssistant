import type { SessionCommands } from '../sessionStorage/contracts'
import {
  formatRemoteOutboundMessage,
  sessionSuffixLength as defaultSessionSuffixLength
} from '../../src/shared/remoteOutboundFormat'
import { touchRemoteSessionActivity } from './remoteSessionActivity'

export function maybeTouchOutboundActivity(
  sessionId: string | undefined,
  touch?: { sessionCommands: Pick<SessionCommands, 'recordRemoteSessionActivity'>; sessionId: string }
): void {
  if (sessionId && touch) {
    touchRemoteSessionActivity(touch.sessionCommands, touch.sessionId)
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
  touch?: { sessionCommands: Pick<SessionCommands, 'recordRemoteSessionActivity'>; sessionId: string }
}): Promise<void> {
  const text = buildSimpleOutboundText(args)
  await args.reply(text)
  maybeTouchOutboundActivity(args.sessionId, args.touch)
}

export type ImLifecycleStage = 'accepted' | 'plan-confirmation' | 'deferred-wait' | 'resumed' | 'completed' | 'failed'

const IM_LIFECYCLE_STAGES = new Set<ImLifecycleStage>([
  'accepted', 'plan-confirmation', 'deferred-wait', 'resumed', 'completed', 'failed'
])

/** Sends one bounded user-facing lifecycle message; internal runtime events have no stage here. */
export async function sendImLifecycleMessage(args: {
  reply: (text: string) => Promise<void>
  stage: ImLifecycleStage
  text: string
}): Promise<void> {
  if (!IM_LIFECYCLE_STAGES.has(args.stage)) throw new TypeError('UNSUPPORTED_IM_LIFECYCLE_STAGE')
  const text = args.text.trim()
  if (!text) throw new TypeError('IM_LIFECYCLE_MESSAGE_REQUIRED')
  await args.reply(text)
}
