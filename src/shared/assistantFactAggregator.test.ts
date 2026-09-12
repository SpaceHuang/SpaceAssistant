import { describe, expect, it } from 'vitest'
import type { Message } from './domainTypes'
import { reduceAssistantFact, type AssistantFactEvent } from './assistantFactAggregator'
import { buildAssistantActivityTimeline } from './assistantActivityTimeline'
import { decodeProgressRawTail } from './terminalScrollback'

const base: Message = {
  id: 'a1', sessionId: 's1', role: 'assistant', content: '', timestamp: 1,
  status: 'streaming', schemaVersion: 1
}

function apply(events: AssistantFactEvent[]) {
  return events.reduce((state, event) => reduceAssistantFact(state, event, { now: 10, createId: () => 'hint-1' }), base)
}

describe('AssistantFactAggregator', () => {
  it('按顺序规约正文和 thinking 分段，并在终止时关闭开放段', () => {
    const result = apply([
      { type: 'content-delta', text: 'hello' },
      { type: 'thinking-delta', text: 'reason' },
      { type: 'content-delta', text: ' world' },
      { type: 'source-completed' }
    ])
    expect(result.content).toBe('hello world')
    expect(result.contentSegments).toHaveLength(2)
    expect(result.contentSegments?.[0]?.content).toBe('hello')
    expect(result.thinking?.content).toBe('reason')
    expect(result.thinking?.endTime).toBe(10)
    expect(result.status).toBe('completed')
  })

  it('工具事件按首次出现创建，重复 progress seq 和终态后事件会被忽略', () => {
    let result = apply([
      { type: 'tool-use', id: 't1', toolName: 'read', input: {} },
      { type: 'tool-progress', id: 't1', seq: 2, text: 'b' },
      { type: 'tool-progress', id: 't1', seq: 1, text: 'a' },
      { type: 'tool-result', id: 't1', result: { success: true, data: 'ok' } },
      { type: 'tool-progress', id: 't1', seq: 3, text: 'late' }
    ])
    expect(result.toolCalls?.[0]).toMatchObject({ status: 'completed', progressOutput: 'b', progressSeq: 2 })
  })

  it('tool progress 只接受正整数 processPid 并保留已确认的 PID', () => {
    const started = apply([{ type: 'tool-use', id: 'pid-tool', toolName: 'run_shell', input: {} }])
    const valid = reduceAssistantFact(started, { type: 'tool-progress', id: 'pid-tool', seq: 1, text: 'running', processPid: 12345 }, { now: 10, createId: () => 'hint-1' })
    expect(valid.toolCalls?.[0]?.processPid).toBe(12345)
    const invalid = reduceAssistantFact(valid, { type: 'tool-progress', id: 'pid-tool', seq: 2, text: 'running', processPid: -1 }, { now: 10, createId: () => 'hint-1' })
    expect(invalid.toolCalls?.[0]?.processPid).toBe(12345)
  })

  it('tool progress 同时校验进程组 ID 和 owner token', () => {
    const started = apply([{ type: 'tool-use', id: 'identity-tool', toolName: 'run_shell', input: {} }])
    const valid = reduceAssistantFact(started, { type: 'tool-progress', id: 'identity-tool', seq: 1, text: 'running', processPid: 10, processGroupId: 10, processOwnerToken: 'request:tool' }, { now: 10, createId: () => 'hint-1' })
    expect(valid.toolCalls?.[0]).toMatchObject({ processPid: 10, processGroupId: 10, processOwnerToken: 'request:tool' })
    const invalid = reduceAssistantFact(valid, { type: 'tool-progress', id: 'identity-tool', seq: 2, text: 'running', processPid: 11, processGroupId: 0, processOwnerToken: '' }, { now: 10, createId: () => 'hint-1' })
    expect(invalid.toolCalls?.[0]).toMatchObject({ processPid: 11, processGroupId: 10, processOwnerToken: 'request:tool' })
  })

  it('M4：terminal rawDelta 累加进 progressOutputRaw 并带上编码标签，base64 不再当成明文进度', () => {
    const started = apply([{ type: 'tool-use', id: 'raw-tool', toolName: 'run_shell', input: {} }])
    const first = Buffer.from('D6D0', 'hex').toString('base64')
    const second = Buffer.from('CEC4B2E2CAD4414243', 'hex').toString('base64')
    const deps = { now: 10, createId: () => 'hint-1' }
    const step1 = reduceAssistantFact(started, { type: 'tool-progress', id: 'raw-tool', seq: 1, text: '', rawDelta: first, rawEncoding: 'gbk' }, deps)
    expect(step1.toolCalls?.[0]).toMatchObject({ status: 'executing', progressOutputRaw: first, progressOutputRawLabel: 'gbk', progressSeq: 1 })
    expect(step1.toolCalls?.[0]?.progressOutput).toBeUndefined()

    const step2 = reduceAssistantFact(step1, { type: 'tool-progress', id: 'raw-tool', seq: 2, text: '', rawDelta: second, rawEncoding: 'gbk' }, deps)
    const accumulated = step2.toolCalls?.[0]?.progressOutputRaw ?? ''
    expect(new TextDecoder('gbk').decode(decodeProgressRawTail(accumulated))).toBe('中文测试ABC')
    expect(step2.toolCalls?.[0]?.progressOutput).toBeUndefined()
  })

  it('M4：后续升级的编码标签会覆盖旧值（实例：先占位后锁定）', () => {
    const started = apply([{ type: 'tool-use', id: 'raw-tool-2', toolName: 'run_shell', input: {} }])
    const deps = { now: 10, createId: () => 'hint-1' }
    const delta = Buffer.from('41', 'hex').toString('base64')
    const first = reduceAssistantFact(started, { type: 'tool-progress', id: 'raw-tool-2', seq: 1, text: '', rawDelta: delta, rawEncoding: 'utf-8' }, deps)
    const second = reduceAssistantFact(first, { type: 'tool-progress', id: 'raw-tool-2', seq: 2, text: '', rawDelta: delta, rawEncoding: 'utf-16le' }, deps)
    expect(second.toolCalls?.[0]?.progressOutputRawLabel).toBe('utf-16le')
  })

  it('工具调用会切断前一段 thinking，工具之后的新 thinking 排在工具之后', () => {
    let now = 100
    let result = base
    const consume = (event: AssistantFactEvent) => {
      result = reduceAssistantFact(result, event, { now: now++, createId: () => 'hint-1' })
    }

    consume({ type: 'thinking-delta', text: 'before tool' })
    consume({ type: 'tool-use', id: 't1', toolName: 'run_shell', input: {} })
    consume({ type: 'thinking-delta', text: 'after tool' })

    expect(result.thinking?.segments).toEqual([
      { content: 'before tool', startTime: 100, endTime: 101 },
      { content: 'after tool', startTime: 102 }
    ])
    expect(buildAssistantActivityTimeline(result)).toEqual([
      { kind: 'thinking', segmentIndex: 0 },
      { kind: 'tool', toolId: 't1' },
      { kind: 'thinking', segmentIndex: 1 }
    ])
  })

  it('重复 tool-use 不会再次切断工具之后的 thinking', () => {
    let now = 200
    let result = base
    const consume = (event: AssistantFactEvent) => {
      result = reduceAssistantFact(result, event, { now: now++, createId: () => 'hint-1' })
    }
    consume({ type: 'tool-use', id: 't1', toolName: 'run_shell', input: {} })
    consume({ type: 'thinking-delta', text: 'after tool' })
    consume({ type: 'tool-use', id: 't1', toolName: 'run_shell', input: {} })
    consume({ type: 'thinking-delta', text: ' still after tool' })

    expect(result.thinking?.segments).toEqual([
      { content: 'after tool still after tool', startTime: 201 }
    ])
  })

  it('终态幂等且迟到 source event 不会复活消息', () => {
    const result = apply([{ type: 'source-failed' }, { type: 'content-delta', text: 'late' }, { type: 'source-completed' }])
    expect(result.status).toBe('failed')
    expect(result.content).toBe('')
  })

  it('usage fact 不改变消息内容，但可以进入统一事实流', () => {
    const result = apply([{ type: 'usage-updated', usage: { input_tokens: 12, output_tokens: 3 } }])
    expect(result).toEqual(base)
  })

  it('确认事实区分批准与拒绝，拒绝不会伪装成执行中', () => {
    const result = apply([
      { type: 'tool-use', id: 't-confirm', toolName: 'run_shell', input: {} },
      { type: 'confirm-requested', id: 't-confirm', riskLevel: 'high' },
      { type: 'tool-confirmed', id: 't-confirm', approved: false, reason: 'user-rejected' }
    ])
    expect(result.toolCalls?.[0]).toMatchObject({ status: 'rejected', rejectionReason: 'user-rejected' })
  })

  it('确认请求保留展示所需元数据，但不包含执行凭据', () => {
    const result = apply([
      { type: 'tool-use', id: 't-meta', toolName: 'run_shell', input: { command: 'pwd' } },
      {
        type: 'confirm-requested',
        id: 't-meta',
        riskLevel: 'high',
        confirmDiff: { oldContent: '', newContent: 'x', oldPath: 'a.txt' },
        shellSecurityHints: { requiresRiskAck: true },
        memoryTiers: [{ key: { kind: 'shell-command', verb: 'pwd', level: 'exact' }, label: '本次命令' }]
      }
    ])
    expect(result.toolCalls?.[0]).toMatchObject({
      status: 'confirming',
      confirmDiff: { oldPath: 'a.txt' },
      shellSecurityHints: { requiresRiskAck: true },
      memoryTiers: [{ label: '本次命令' }]
    })
    expect(result.toolCalls?.[0]).not.toHaveProperty('permit')
  })
})
