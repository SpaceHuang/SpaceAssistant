import type { IncomingMessage } from '@wechatbot/wechatbot'
import type { LarkCliRunner } from '../feishu/larkCliRunner'
import { sendFeishuRemoteOutbound } from '../feishu/feishuRemoteOutbound'
import { sendWeChatRemoteOutbound } from '../wechat/weChatRemoteOutbound'
import type { WeChatReplyBot } from '../wechat/weChatReplyService'
import type {
  RemoteArtifactDecisionAuditEvent,
  RemoteContext
} from '../tools/types'

export function createFeishuSendDecisionText(args: {
  runner: LarkCliRunner
  messageId: string
  chatId: string
  sessionId?: string
}): NonNullable<RemoteContext['sendDecisionText']> {
  const { runner, messageId, sessionId } = args
  void args.chatId
  return async (text: string) => {
    await sendFeishuRemoteOutbound({
      runner,
      messageId,
      body: text,
      sessionId
    })
  }
}

export function createWeChatSendDecisionText(args: {
  bot: WeChatReplyBot
  inbound: IncomingMessage
  userId: string
  sessionId?: string
}): NonNullable<RemoteContext['sendDecisionText']> {
  const { bot, inbound, sessionId } = args
  void args.userId
  return async (text: string) => {
    await sendWeChatRemoteOutbound({
      bot,
      inbound,
      body: text,
      sessionId
    })
  }
}

export function createArtifactDecisionAuditAppender(args: {
  source: 'feishu' | 'wechat'
  append: (entry: Record<string, unknown>) => void | Promise<void>
}): NonNullable<RemoteContext['appendArtifactDecisionAudit']> {
  const prefix = args.source === 'feishu' ? 'feishu.artifact_decision' : 'wechat.artifact_decision'
  return (event: RemoteArtifactDecisionAuditEvent, fields) =>
    args.append({
      type: `${prefix}.${event}`,
      ...fields
    })
}

/**
 * Send decision prompt to the fixed IM target. Audit failures after a successful send
 * must not cancel the pending waiter (design: only send failure closes the wait).
 */
export async function sendRemoteArtifactDecisionPrompt(args: {
  sendDecisionText: (text: string) => Promise<void>
  appendAudit?: NonNullable<RemoteContext['appendArtifactDecisionAudit']>
  text: string
  decisionId: string
  kind: string
  originSessionId: string
  requestId: string
}): Promise<void> {
  try {
    await args.sendDecisionText(args.text)
  } catch (error) {
    const summary = error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)
    try {
      await args.appendAudit?.('prompt_failed', {
        decisionId: args.decisionId,
        errorClass: error instanceof Error ? error.name : 'Error',
        summary
      })
    } catch {
      // best-effort audit
    }
    throw error
  }
  try {
    await args.appendAudit?.('prompt', {
      decisionId: args.decisionId,
      kind: args.kind,
      originSessionId: args.originSessionId,
      requestId: args.requestId
    })
  } catch {
    // Send already succeeded — do not cancel the decision over audit failure.
  }
}
