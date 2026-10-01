import type { LarkCliRunner } from './larkCliRunner'
import { logFeishuCliEvent } from './feishuCliLogger'
import { sendFeishuRemoteOutbound } from './feishuRemoteOutbound'

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
  let response: unknown
  try { response = JSON.parse(result.stdout) as unknown }
  catch { throw new Error('FEISHU_DELIVERY_RESPONSE_UNKNOWN') }
  if (!response || typeof response !== 'object' || Array.isArray(response) || (response as { code?: unknown }).code !== 0) {
    throw new Error('FEISHU_DELIVERY_REJECTED')
  }
}

export async function replyFeishuTextRaw(
  runner: LarkCliRunner,
  messageId: string,
  text: string
): Promise<void> {
  const body = JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) })
  const r = await runner.run({
    args: ['api', 'POST', `/open-apis/im/v1/messages/${messageId}/reply`, '--data', body, '--as', 'bot', '--format', 'json'],
    timeoutSec: 30
  })
  logFeishuCliEvent('info', 'feishu.reply.send', {
    messageId,
    textLen: text.length,
    truncated: false,
    exitCode: r.exitCode
  })
}

/** Tier-0 早退出站；Tier-1 请使用 sendFeishuRemoteOutbound */
export async function replyFeishuText(
  runner: LarkCliRunner,
  messageId: string,
  text: string
): Promise<void> {
  await sendFeishuRemoteOutbound({ runner, messageId, body: text })
}
