import { describe, expect, it } from 'vitest'
import {
  buildClaudeChatSendStreamParams,
  buildClaudeNarrativeCompletionParams,
  buildClaudeToolLoopStreamParams
} from './claudeToolLoopStreamParams'

describe('buildClaudeToolLoopStreamParams', () => {
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
})
