import type { LarkCliRunner } from './larkCliRunner'
import { logFeishuCliEvent } from './feishuCliLogger'
import { sendFeishuRemoteOutbound, sendFeishuRemoteOutboundWithId } from './feishuRemoteOutbound'

function parseApiData(stdout: string, responseUnknownCode: string, rejectedCode: string): unknown {
  let response: unknown
  try { response = JSON.parse(stdout) as unknown }
  catch { throw new Error(responseUnknownCode) }
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error(rejectedCode)
  const envelope = response as { ok?: unknown; code?: unknown; data?: unknown }
  if ('ok' in envelope) {
    if (envelope.ok !== true) throw new Error(rejectedCode)
    return envelope.data
  }
  if (envelope.code !== 0) throw new Error(rejectedCode)
  return envelope.data
}

function getMessageId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const messageId = (data as { message_id?: unknown }).message_id
  return typeof messageId === 'string' && messageId.trim() ? messageId : undefined
}

/** Send a scheduled result to a stable recipient through the bot identity. */
export async function sendFeishuTextToTarget(runner: LarkCliRunner, rawTarget: string, text: string): Promise<void> {
  const target = rawTarget.trim()
  const typedTarget = /^(open_id|chat_id):(\S+)$/.exec(target)
  const receiveIdType = typedTarget?.[1] ?? 'open_id'
  const receiveId = typedTarget?.[2] ?? target
  if (!receiveId) throw new Error('FEISHU_DELIVERY_TARGET_REQUIRED')
  const result = await runner.run({
    args: ['api', 'POST', '/open-apis/im/v1/messages', '--params', JSON.stringify({ receive_id_type: receiveIdType }), '--data', JSON.stringify({ receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) }), '--as', 'bot', '--format', 'json'],
    timeoutSec: 30
  })
  if (result.timedOut || result.exitCode !== 0) throw new Error(`FEISHU_DELIVERY_FAILED:${result.timedOut ? 'timeout' : result.exitCode}`)
  parseApiData(result.stdout, 'FEISHU_DELIVERY_RESPONSE_UNKNOWN', 'FEISHU_DELIVERY_REJECTED')
}

/** Send an approval notification and return the platform message ID required for reply-to binding. */
export async function sendFeishuApprovalTextToTarget(runner: LarkCliRunner, rawTarget: string, text: string): Promise<{ messageId: string }> {
  const target = rawTarget.trim()
  const typedTarget = /^(open_id|chat_id):(\S+)$/.exec(target)
  const receiveIdType = typedTarget?.[1] ?? 'open_id'
  const receiveId = typedTarget?.[2] ?? target
  if (!receiveId) throw new Error('FEISHU_DELIVERY_TARGET_REQUIRED')
  const result = await runner.run({
    args: ['api', 'POST', '/open-apis/im/v1/messages', '--params', JSON.stringify({ receive_id_type: receiveIdType }), '--data', JSON.stringify({ receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) }), '--as', 'bot', '--format', 'json'],
    timeoutSec: 30
  })
  if (result.timedOut || result.exitCode !== 0) throw new Error(`FEISHU_DELIVERY_FAILED:${result.timedOut ? 'timeout' : result.exitCode}`)
  const data = parseApiData(result.stdout, 'FEISHU_DELIVERY_RESPONSE_UNKNOWN', 'FEISHU_DELIVERY_REJECTED')
  const messageId = getMessageId(data)
  if (!messageId) throw new Error('FEISHU_DELIVERY_MESSAGE_ID_MISSING')
  return { messageId }
}

async function replyFeishuTextRawInternal(
  runner: LarkCliRunner,
  messageId: string,
  text: string,
  requireMessageId: boolean
): Promise<string | undefined> {
  const body = JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) })
  const r = await runner.run({
    args: ['api', 'POST', `/open-apis/im/v1/messages/${messageId}/reply`, '--data', body, '--as', 'bot', '--format', 'json'],
    timeoutSec: 30
  })
  if (r.timedOut || r.exitCode !== 0) throw new Error(`FEISHU_REPLY_FAILED:${r.timedOut ? 'timeout' : r.exitCode}`)
  const data = parseApiData(r.stdout, 'FEISHU_REPLY_RESPONSE_UNKNOWN', 'FEISHU_REPLY_REJECTED')
  const sentMessageId = getMessageId(data)
  if (requireMessageId && !sentMessageId) throw new Error('FEISHU_DELIVERY_MESSAGE_ID_MISSING')
  logFeishuCliEvent('info', 'feishu.reply.send', {
    messageId,
    textLen: text.length,
    truncated: false,
    exitCode: r.exitCode
  })
  return sentMessageId
}

/** Ordinary replies do not require a response ID, but return one when the API provides it. */
export async function replyFeishuTextRaw(runner: LarkCliRunner, messageId: string, text: string): Promise<{ messageId: string } | undefined> {
  const sentMessageId = await replyFeishuTextRawInternal(runner, messageId, text, false)
  return sentMessageId ? { messageId: sentMessageId } : undefined
}

/** Confirmation prompts need a response ID so later replies can be bound to this exact prompt. */
export async function replyFeishuTextRawWithId(runner: LarkCliRunner, messageId: string, text: string): Promise<{ messageId: string }> {
  const sentMessageId = await replyFeishuTextRawInternal(runner, messageId, text, true)
  if (!sentMessageId) throw new Error('FEISHU_DELIVERY_MESSAGE_ID_MISSING')
  return { messageId: sentMessageId }
}

/** Tier-0 早退出站；Tier-1 请使用 sendFeishuRemoteOutbound */
export async function replyFeishuText(
  runner: LarkCliRunner,
  messageId: string,
  text: string
): Promise<void> {
  await sendFeishuRemoteOutbound({ runner, messageId, body: text })
}

export async function replyFeishuTextWithId(
  runner: LarkCliRunner,
  messageId: string,
  text: string,
  binding: { sessionId: string; recipient: string; outboundDeliveryFacts: import('../../src/shared/confirmation/outboundClassification').ImOutboundFacts }
): Promise<{ messageId: string }> {
  return sendFeishuRemoteOutboundWithId({ runner, messageId, body: text, ...binding })
}
