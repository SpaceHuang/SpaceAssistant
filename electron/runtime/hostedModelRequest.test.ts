import { describe, expect, it } from 'vitest'
import { bindHostedRequiredUserMessage, canonicalHostedRequiredUserMessage, createHostedModelRequest } from './hostedModelRequest'

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
        { role: 'user', id: 'current-user', content: '请读取文件' },
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

  it('matches equivalent accepted text after recovery changes string content into a text block', () => {
    const originalMessages = [{ id: 'current-user', role: 'user' as const, content: '继续' }]
    const requestMessages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '继续' }] }]
    expect(bindHostedRequiredUserMessage({ id: 'current-user', originalMessages, requestMessages })).toEqual({
      id: 'current-user', message: { role: 'user', content: [{ type: 'text', text: '继续' }] }
    })
  })

  it('rejects missing or mismatched current-user content', () => {
    const originalMessages = [{ id: 'current-user', role: 'user' as const, content: 'same' }]
    expect(bindHostedRequiredUserMessage({ id: 'current-user', originalMessages, requestMessages: [] })).toBeUndefined()
    expect(bindHostedRequiredUserMessage({
      id: 'current-user', originalMessages,
      requestMessages: [{ role: 'user', content: 'different' }]
    })).toBeUndefined()
  })

  it('binds the current user by message position when earlier turns used identical text', () => {
    const originalMessages = [
      { id: 'earlier-user', role: 'user' as const, content: '继续' },
      { id: 'earlier-assistant', role: 'assistant' as const, content: '请补充信息。' },
      { id: 'current-user', role: 'user' as const, content: '继续' }
    ]
    const requestMessages = [
      { role: 'user' as const, content: '继续' },
      { role: 'assistant' as const, content: '请补充信息。' },
      { role: 'user' as const, content: '继续' }
    ]
    expect(bindHostedRequiredUserMessage({ id: 'current-user', originalMessages, requestMessages })).toEqual({
      id: 'current-user', message: { role: 'user', content: '继续' }
    })
  })

  it('binds the actual user text when role repair merged a preceding tool result into the same user message', () => {
    const originalMessages = [{
      id: 'current-user', role: 'user' as const,
      content: [
        { type: 'tool_result' as const, tool_use_id: 'previous-call', content: 'tool output' },
        { type: 'text' as const, text: 'Q' }
      ]
    }]
    const requestMessages = [
      { role: 'tool' as const, toolCallId: 'previous-call', content: 'tool output', isError: false },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Q' }] }
    ]
    expect(bindHostedRequiredUserMessage({ id: 'current-user', originalMessages, requestMessages })).toEqual({
      id: 'current-user', message: { role: 'user', content: [{ type: 'text', text: 'Q' }] }
    })
  })

  it('selects the accepted user portion after canonicalizing a mixed tool-result user message', () => {
    expect(canonicalHostedRequiredUserMessage({
      role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'previous-call', content: 'tool output' },
        { type: 'text', text: '继续' }
      ]
    } as never)).toEqual({ role: 'user', content: [{ type: 'text', text: '继续' }] })
  })
})
