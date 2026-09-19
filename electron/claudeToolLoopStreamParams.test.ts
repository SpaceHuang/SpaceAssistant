import { describe, expect, it } from 'vitest'
import {
  buildClaudeChatSendStreamParams,
  buildClaudeNarrativeCompletionParams,
  serializeProviderMessages,
  buildClaudeToolLoopStreamParams
} from './claudeToolLoopStreamParams'

describe('buildClaudeToolLoopStreamParams', () => {
  it('does not serialize local surface metadata to the provider', () => {
    const p = buildClaudeToolLoopStreamParams({ model: 'm', max_tokens: 10, system: 'sys', messages: [{ id: 'local-id', timestamp: 1, role: 'user', content: 'hello' }], tools: [], thinking: { type: 'disabled' }, cacheControl: true })
    expect(p.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }])
  })
  it('adds cache breakpoints to system and deepest stable message when enabled', () => {
    const p = buildClaudeToolLoopStreamParams({ model: 'm', max_tokens: 10, system: 'sys', messages: [{ role: 'user', content: 'hello' }], tools: [], thinking: { type: 'disabled' }, cacheControl: true })
    expect(p.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }])
    expect(p.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }])
  })
  const messages = [{ role: 'user', content: 'hi' }]
  const tools = [{ name: 't', description: 'd', input_schema: { type: 'object', properties: {} } }]

  it('orders keys with thinking last when system is absent', () => {
    const p = buildClaudeToolLoopStreamParams({
      model: 'm',
      max_tokens: 100,
      messages,
      tools,
      thinking: { type: 'disabled' }
    })
    expect(Object.keys(p)).toEqual(['model', 'max_tokens', 'messages', 'tools', 'tool_choice', 'thinking'])
    expect(p.thinking).toEqual({ type: 'disabled' })
    expect(p.tool_choice).toEqual({ type: 'auto' })
  })

  it('inserts system between max_tokens and messages; thinking remains last', () => {
    const p = buildClaudeToolLoopStreamParams({
      model: 'm',
      max_tokens: 100,
      system: '  you are helpful  ',
      messages,
      tools,
      thinking: { type: 'adaptive' }
    })
    expect(Object.keys(p)).toEqual([
      'model',
      'max_tokens',
      'system',
      'messages',
      'tools',
      'tool_choice',
      'thinking'
    ])
    expect(p.system).toBe('  you are helpful  ')
    expect(p.thinking).toEqual({ type: 'adaptive' })
  })

  // §7.3 档位 → wire：output_config 在 tool_choice 之后、thinking 之前（thinking 仍置尾）
  it('emits output_config with effort between tool_choice and thinking', () => {
    const p = buildClaudeToolLoopStreamParams({
      model: 'm',
      max_tokens: 100,
      messages,
      tools,
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'low' }
    })
    expect(Object.keys(p)).toEqual(['model', 'max_tokens', 'messages', 'tools', 'tool_choice', 'output_config', 'thinking'])
    expect(p.output_config).toEqual({ effort: 'low' })
  })

  it('keeps output_config before thinking when a system prompt is present', () => {
    const p = buildClaudeToolLoopStreamParams({
      model: 'm',
      max_tokens: 100,
      system: 'sys',
      messages,
      tools,
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'high' }
    })
    expect(Object.keys(p)).toEqual(['model', 'max_tokens', 'system', 'messages', 'tools', 'tool_choice', 'output_config', 'thinking'])
    expect(p.output_config).toEqual({ effort: 'high' })
  })

  it('omits output_config when off / not provided (off 请求不含强度字段)', () => {
    const p = buildClaudeToolLoopStreamParams({ model: 'm', max_tokens: 100, messages, tools, thinking: { type: 'disabled' } })
    expect(p.output_config).toBeUndefined()
    expect(Object.keys(p)).not.toContain('output_config')
    const p2 = buildClaudeToolLoopStreamParams({ model: 'm', max_tokens: 100, messages, tools, thinking: { type: 'disabled' }, outputConfig: undefined })
    expect(p2.output_config).toBeUndefined()
  })

  it('low 与 high 的请求体不相等（档位未被折叠，§10.3）', () => {
    const base = { model: 'm', max_tokens: 100, messages, tools, thinking: { type: 'adaptive' } as const }
    const low = buildClaudeToolLoopStreamParams({ ...base, outputConfig: { effort: 'low' } })
    const high = buildClaudeToolLoopStreamParams({ ...base, outputConfig: { effort: 'high' } })
    expect(JSON.stringify(low)).not.toBe(JSON.stringify(high))
  })
})

describe('provider message serialization', () => {
  it('whitelists role and content for every Anthropic message path', () => {
    expect(serializeProviderMessages([{ id: 'local', timestamp: 1, role: 'user', content: 'hello' }])).toEqual([{ role: 'user', content: 'hello' }])
  })
})

describe('buildClaudeChatSendStreamParams', () => {
  it('places thinking after messages', () => {
    const p = buildClaudeChatSendStreamParams({
      model: 'x',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'a' }],
      thinking: { type: 'adaptive' }
    })
    expect(Object.keys(p)).toEqual(['model', 'max_tokens', 'messages', 'thinking'])
  })

  it('includes system when provided', () => {
    const p = buildClaudeChatSendStreamParams({
      model: 'x',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'a' }],
      system: 'skill prompt',
      thinking: { type: 'adaptive' }
    })
    expect(Object.keys(p)).toEqual(['model', 'max_tokens', 'system', 'messages', 'thinking'])
    expect(p.system).toBe('skill prompt')
  })
})

describe('buildClaudeNarrativeCompletionParams', () => {
  it('adds cache_control when provided', () => {
    const p = buildClaudeNarrativeCompletionParams({
      model: 'x',
      max_tokens: 4096,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'disabled' },
      cache_control: { type: 'ephemeral' }
    })
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('emits output_config with effort and keeps it before thinking', () => {
    const p = buildClaudeNarrativeCompletionParams({
      model: 'x',
      max_tokens: 4096,
      system: 'sys',
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'medium' }
    })
    expect(p.output_config).toEqual({ effort: 'medium' })
    expect(Object.keys(p).indexOf('output_config')).toBeLessThan(Object.keys(p).indexOf('thinking'))
  })

  it('omits output_config when not provided', () => {
    const p = buildClaudeNarrativeCompletionParams({
      model: 'x',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'disabled' }
    })
    expect(p.output_config).toBeUndefined()
  })
})
