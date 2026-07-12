import type { LarkCliRunner } from './larkCliRunner'
import { logFeishuCliEvent } from './feishuCliLogger'
import { sendFeishuRemoteOutbound } from './feishuRemoteOutbound'

export async function replyFeishuTextRaw(
  runner: LarkCliRunner,
  messageId: string,
  text: string
): Promise<void> {
  const body = JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) })
  const r = await runner.run({
    args: ['api', 'POST', `/open-apis/im/v1/messages/${messageId}/reply`, '--data', body, '--as', 'bot', '--format', 'data'],
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
