import type { LarkCliRunner } from './larkCliRunner'
import { logFeishuCliEvent } from './feishuCliLogger'

export async function replyFeishuText(
  runner: LarkCliRunner,
  messageId: string,
  text: string
): Promise<void> {
  const truncated = text.length > 4000 ? `${text.slice(0, 3990)}…（完整结果请查看桌面会话）` : text
  const body = JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text: truncated }) })
  const r = await runner.run({
    args: ['api', 'POST', `/open-apis/im/v1/messages/${messageId}/reply`, '--data', body, '--as', 'bot', '--format', 'data'],
    timeoutSec: 30
  })
  logFeishuCliEvent('info', 'feishu.reply.send', {
    messageId,
    textLen: text.length,
    truncated: text.length > 4000,
    exitCode: r.exitCode
  })
}
