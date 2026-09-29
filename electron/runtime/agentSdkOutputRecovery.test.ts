import { describe, expect, it } from 'vitest'
import { createAgentSdkOutputRecovery } from './agentSdkOutputRecovery'

describe('createAgentSdkOutputRecovery', () => {
  it('preserves original-task continuation semantics and caps recoveries at the legacy limit', async () => {
    const recover = createAgentSdkOutputRecovery()
    const first = await recover({ invocationId: 'inv', modelTurn: 3, attempt: 1, hadVisibleText: true, toolCalls: [] })
    const second = await recover({ invocationId: 'inv', modelTurn: 4, attempt: 2, hadVisibleText: false, toolCalls: [] })
    const exhausted = await recover({ invocationId: 'inv', modelTurn: 5, attempt: 3, hadVisibleText: true, toolCalls: [] })

    expect(first?.continuation).toMatchObject({ role: 'user', content: expect.stringContaining('上一轮已生成部分用户可见正文') })
    expect(second?.continuation).toMatchObject({ role: 'user', content: expect.stringContaining('上一轮没有生成用户可见正文') })
    expect(exhausted?.continuation).toBeUndefined()
    expect(exhausted?.toolCallErrorContent).toContain('本轮工具生成因达到输出 token 上限而被截断')
  })

  it('tells the model that truncated tool proposals did not execute', async () => {
    const recover = createAgentSdkOutputRecovery()
    const message = await recover({
      invocationId: 'inv', modelTurn: 1, attempt: 1, hadVisibleText: false,
      toolCalls: [{ invocationId: 'inv', toolCallId: 'tool-1', toolName: 'write_file', input: { path: 'a' } }]
    })
    expect(message?.continuation?.content).toContain('上一轮已生成工具调用，但因输出被截断而未执行')
    expect(message?.toolCallErrorContent).toContain('本轮工具生成因达到输出 token 上限而被截断')
  })
})
