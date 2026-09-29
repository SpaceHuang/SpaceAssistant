import { describe, expect, it } from 'vitest'
import { bindHostedRequiredUserMessage, createHostedModelRequest } from './hostedModelRequest'

describe('createHostedModelRequest', () => {
  it('直接生成完整的 canonical Hosted request', () => {
    const messages = [
      { id: 'current-user', role: 'user' as const, content: '请读取文件' },
      { role: 'assistant' as const, content: [{ type: 'thinking', thinking: 'reason', signature: 'sig' }, { type: 'text', text: '我来读取' }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'read-1', content: '文件内容' }] }
    ]
    const tools = [
      { name: 'read_file', description: '读取文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'history_read', description: '读取历史', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'skills_read', description: '读取技能', input_schema: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'toolkit_find', description: '查找工具包', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }
    ]
    const controller = new AbortController()
    const input = {
      system: 'system prompt', messages, tools, maxTokens: 1024,
      thinking: { type: 'adaptive' as const }, effort: 'high' as const,
      apiKey: 'request-secret', signal: controller.signal
    }
    expect(createHostedModelRequest(input)).toEqual({
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: '请读取文件' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'reason', thinkingSignature: 'sig' },
          { type: 'text', text: '我来读取' }
        ] },
        { role: 'tool', toolCallId: 'read-1', content: '文件内容', isError: false }
      ],
      maxTokens: 1024,
      credentials: { apiKey: 'request-secret' },
      signal: controller.signal,
      tools: [
        { name: 'read_file', description: '读取文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'history_read', description: '读取历史', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
        { name: 'skills_read', description: '读取技能', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
        { name: 'toolkit_find', description: '查找工具包', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
      ],
      thinking: { enabled: true, effort: 'high' }
    })
  })
})

describe('bindHostedRequiredUserMessage', () => {
  it('binds by canonical content when transcript replay preserved the user message but lost its id', () => {
    const originalMessages = [{ id: 'current-user', role: 'user' as const, content: 'continue this task' }]
    const requestMessages = [{ role: 'system' as const, content: 'dynamic prompt' }, { role: 'user' as const, content: 'continue this task' }]
    expect(bindHostedRequiredUserMessage({ id: 'current-user', originalMessages, requestMessages })).toEqual({
      id: 'current-user', message: { role: 'user', content: 'continue this task' }
    })
  })

  it('rejects missing or ambiguous current-user content', () => {
    const originalMessages = [{ id: 'current-user', role: 'user' as const, content: 'same' }]
    expect(bindHostedRequiredUserMessage({ id: 'current-user', originalMessages, requestMessages: [] })).toBeUndefined()
    expect(bindHostedRequiredUserMessage({
      id: 'current-user', originalMessages,
      requestMessages: [{ role: 'user', content: 'same' }, { role: 'user', content: 'same' }]
    })).toBeUndefined()
  })
})
