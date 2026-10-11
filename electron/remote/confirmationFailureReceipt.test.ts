import { describe, expect, it } from 'vitest'
import { projectConfirmationSendFailures } from './confirmationFailureReceipt'

const callEvent = { kind: 'model-response-committed', payload: { message: { toolCalls: [{ id: 'call-1', name: 'run_script' }] } } }

describe('confirmation prompt failure receipt projection', () => {
  it.each([
    ['not-attempted', { kind: 'confirmation-prompt-send-failed', state: 'not-attempted', sendCall: 'not-attempted', delivery: 'not-attempted', errorCategory: 'bot-unavailable' }, '未尝试发送'],
    ['send-rejected', { kind: 'confirmation-prompt-send-failed', state: 'send-rejected', sendCall: 'rejected', delivery: 'unknown', errorCategory: 'transport-failed' }, '发送调用失败'],
    ['send-pending', { kind: 'confirmation-prompt-send-failed', state: 'send-pending', sendCall: 'pending', delivery: 'unknown', errorCategory: 'unknown' }, '发送调用尚未完成'],
    ['binding-unavailable', { kind: 'confirmation-prompt-send-failed', state: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unavailable', errorCategory: 'message-binding-unavailable' }, '发送调用已成功，但无法绑定'],
  ] as const)('准确投影 %s 状态', (_state, promptSendFailure, expected) => {
    const projection = projectConfirmationSendFailures([
      callEvent,
      { kind: 'approval-resolved', payload: { toolCallId: 'call-1', promptSendFailure } }
    ])

    expect(projection?.summary).toContain(expected)
    expect(projection?.summary).toContain('相关操作未执行')
  })

  it('显式兼容旧版合法事实并保留语义', () => {
    const projection = projectConfirmationSendFailures([
      callEvent,
      { kind: 'approval-resolved', payload: { toolCallId: 'call-1', promptSendFailure: {
        kind: 'confirmation-prompt-send-failed', sendCall: 'fulfilled', delivery: 'unavailable', errorCategory: 'message-binding-unavailable'
      } } }
    ])

    expect(projection?.summary).toContain('发送调用已成功，但无法绑定')
  })

  it('未知或矛盾的历史状态不得被误报为未发送', () => {
    const projection = projectConfirmationSendFailures([
      callEvent,
      { kind: 'approval-resolved', payload: { toolCallId: 'call-1', promptSendFailure: {
        kind: 'confirmation-prompt-send-failed', state: 'future-state', sendCall: 'fulfilled', delivery: 'unavailable'
      } } }
    ])

    expect(projection?.summary).toContain('发送状态无法判定')
    expect(projection?.summary).not.toContain('未发送')
  })

  it('新状态的错误分类与判别分支矛盾时回退为状态未知', () => {
    const projection = projectConfirmationSendFailures([
      callEvent,
      { kind: 'approval-resolved', payload: { toolCallId: 'call-1', promptSendFailure: {
        kind: 'confirmation-prompt-send-failed', state: 'send-pending', sendCall: 'pending', delivery: 'unknown', errorCategory: 'transport-failed'
      } } }
    ])

    expect(projection?.summary).toContain('发送状态无法判定')
    expect(projection?.summary).not.toContain('尚未完成')
  })

  it('成功结果不产生失败回执，其余成功工具不进入失败摘要', () => {
    const projection = projectConfirmationSendFailures([
      callEvent,
      { kind: 'model-response-committed', payload: { message: { toolCalls: [{ id: 'call-2', name: 'read_file' }] } } },
      { kind: 'approval-resolved', payload: { toolCallId: 'call-2' } }
    ])

    expect(projection).toBeUndefined()
  })
})
