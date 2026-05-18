import { describe, it, expect } from 'vitest'
import type { Message, ToolCallRecord } from '../../../shared/domainTypes'
import { extractReferencedFiles } from './useReferencedFiles'

function makeToolCall(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id' | 'toolName'>): ToolCallRecord {
  return {
    input: {},
    status: 'completed',
    riskLevel: 'low',
    ...overrides,
  } as ToolCallRecord
}

function makeMessage(toolCalls: ToolCallRecord[]): Message {
  return {
    id: `msg-${Math.random()}`,
    sessionId: 'sess-1',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    toolCalls,
    status: 'completed',
    schemaVersion: 1,
  }
}

describe('extractReferencedFiles', () => {
  it('从消息中提取 read_file 操作的文件', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: { path: 'src/index.ts' }, completedAt: 1000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('src/index.ts')
    expect(result[0].lastOperation).toBe('read')
    expect(result[0].referenceCount).toBe(1)
  })

  it('从消息中提取 write_file 操作的文件', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'write_file', input: { path: 'output.txt' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('output.txt')
    expect(result[0].lastOperation).toBe('write')
  })

  it('edit_file 归类为 write 操作', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'edit_file', input: { path: 'config.json' }, completedAt: 3000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result[0].lastOperation).toBe('write')
  })

  it('同一文件多次操作时去重并更新', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: { path: 'app.ts' }, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'edit_file', input: { path: 'app.ts' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(1)
    expect(result[0].lastReferencedAt).toBe(2000)
    expect(result[0].lastOperation).toBe('write')
    expect(result[0].referenceCount).toBe(2)
  })

  it('按 lastReferencedAt 倒序排列', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: { path: 'a.ts' }, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'read_file', input: { path: 'b.ts' }, completedAt: 3000 }),
        makeToolCall({ id: 'tc-3', toolName: 'read_file', input: { path: 'c.ts' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result.map((f) => f.path)).toEqual(['b.ts', 'c.ts', 'a.ts'])
  })

  it('忽略非 completed 状态的工具调用', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: { path: 'a.ts' }, status: 'failed', completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'write_file', input: { path: 'b.ts' }, status: 'rejected', completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(0)
  })

  it('忽略 input.path 为空的工具调用', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'read_file', input: {}, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'read_file', input: { path: '' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(0)
  })

  it('忽略 list_directory / grep / run_script 工具', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'list_directory', input: { path: 'src' }, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'grep', input: { path: 'src' }, completedAt: 2000 }),
        makeToolCall({ id: 'tc-3', toolName: 'run_script', input: { code: 'print(1)' }, completedAt: 3000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(0)
  })

  it('过滤一次性脚本', () => {
    const messages: Message[] = [
      makeMessage([
        makeToolCall({ id: 'tc-1', toolName: 'write_file', input: { path: 'script_fix.py' }, completedAt: 1000 }),
        makeToolCall({ id: 'tc-2', toolName: 'read_file', input: { path: 'src/index.ts' }, completedAt: 2000 }),
      ]),
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('src/index.ts')
  })

  it('处理无 toolCalls 的消息', () => {
    const messages: Message[] = [
      {
        id: 'msg-1',
        sessionId: 'sess-1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
        status: 'completed',
        schemaVersion: 1,
      },
    ]
    const result = extractReferencedFiles(messages)
    expect(result).toHaveLength(0)
  })

  it('无消息时返回空数组', () => {
    const result = extractReferencedFiles([])
    expect(result).toHaveLength(0)
  })
})
