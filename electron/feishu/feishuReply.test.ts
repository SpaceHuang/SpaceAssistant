import { describe, expect, it, vi } from 'vitest'
import { sendFeishuApprovalTextToTarget, sendFeishuTextToTarget } from './feishuReply'

describe('sendFeishuTextToTarget', () => {
  it('uses open_id by default and encodes a text message through the bot API', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '{"code":0}', stderr: '', timedOut: false }))
    await sendFeishuTextToTarget({ run } as never, 'ou_123', 'scheduled result')
    const args = run.mock.calls[0]![0].args
    expect(args).toContain('/open-apis/im/v1/messages')
    expect(JSON.parse(args[args.indexOf('--params') + 1]!)).toEqual({ receive_id_type: 'open_id' })
    expect(args.slice(-2)).toEqual(['--format', 'json'])
    const data = JSON.parse(args[args.indexOf('--data') + 1]!) as { receive_id: string; msg_type: string; content: string }
    expect(data).toEqual({ receive_id: 'ou_123', msg_type: 'text', content: JSON.stringify({ text: 'scheduled result' }) })
  })

  it('accepts explicit chat_id and reports remote send failures', async () => {
    const run = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'failed', timedOut: false }))
    await expect(sendFeishuTextToTarget({ run } as never, 'chat_id:oc_123', 'result')).rejects.toThrow('FEISHU_DELIVERY_FAILED:1')
    const args = run.mock.calls[0]![0].args
    expect(JSON.parse(args[args.indexOf('--params') + 1]!)).toEqual({ receive_id_type: 'chat_id' })
  })

  it('does not treat an API-level rejection as confirmed delivery', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '{"code":99991663}', stderr: '', timedOut: false }))
    await expect(sendFeishuTextToTarget({ run } as never, 'ou_123', 'result')).rejects.toThrow('FEISHU_DELIVERY_REJECTED')
  })
})

describe('sendFeishuApprovalTextToTarget', () => {
  it('returns the platform message id needed to bind a reply to the delivered notification', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '{"code":0,"data":{"message_id":"approval-message-1"}}', stderr: '', timedOut: false }))
    await expect(sendFeishuApprovalTextToTarget({ run } as never, 'ou_123', 'approval notice'))
      .resolves.toEqual({ messageId: 'approval-message-1' })
  })

  it('fails closed when the platform response omits a message id', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '{"code":0}', stderr: '', timedOut: false }))
    await expect(sendFeishuApprovalTextToTarget({ run } as never, 'ou_123', 'approval notice'))
      .rejects.toThrow('FEISHU_DELIVERY_MESSAGE_ID_MISSING')
  })
})
