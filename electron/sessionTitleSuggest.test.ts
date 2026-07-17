import { describe, expect, it } from 'vitest'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import type { Message } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/domainTypes'
import {
  buildTitleSuggestDialogueText,
  formatTitleDialogueLabel,
  getTitleSystemPrompt,
  reachedCumulativeAssistantTurnsForTitleSuggest,
  countCompletedAssistantMessagesForTitleSuggest
} from './sessionTitleSuggest'

function msg(role: 'user' | 'assistant', content: MessageParam['content']): MessageParam {
  return { role, content }
}

describe('getTitleSystemPrompt', () => {
  it('T1: zh-CN matches existing Chinese prompt', () => {
    const prompt = getTitleSystemPrompt('zh-CN')
    expect(prompt).toContain('64个汉字')
    expect(prompt).toContain('只输出主题文字')
  })

  it('T2: en-US includes in English and 64 Unicode characters limit', () => {
    const prompt = getTitleSystemPrompt('en-US')
    expect(prompt).toContain('in English')
    expect(prompt).toContain('64 Unicode characters')
  })
})

describe('buildTitleSuggestDialogueText locale labels', () => {
  const messages: MessageParam[] = [
    msg('user', 'hello'),
    msg('assistant', [{ type: 'text', text: 'hi there' }])
  ]

  it('T3: en-US uses User: / Assistant: prefixes', () => {
    const out = buildTitleSuggestDialogueText(messages, 1, 'en-US')
    expect(out).toContain('User: hello')
    expect(out).toContain('Assistant: hi there')
  })

  it('T4: zh-CN uses 用户： / 助手： prefixes', () => {
    const out = buildTitleSuggestDialogueText(messages, 1, 'zh-CN')
    expect(out).toContain('用户：hello')
    expect(out).toContain('助手：hi there')
  })
})

describe('formatTitleDialogueLabel', () => {
  it('returns locale-specific labels', () => {
    expect(formatTitleDialogueLabel('user', 'en-US')).toBe('User: ')
    expect(formatTitleDialogueLabel('assistant', 'en-US')).toBe('Assistant: ')
    expect(formatTitleDialogueLabel('user', 'zh-CN')).toBe('用户：')
    expect(formatTitleDialogueLabel('assistant', 'zh-CN')).toBe('助手：')
  })
})

describe('buildTitleSuggestDialogueText', () => {
  it('strips tool blocks and stops after N assistant turns', () => {
    const messages: MessageParam[] = [
      msg('user', '你好'),
      msg('assistant', [{ type: 'text', text: '你好，需要什么？' }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'x', content: 'ignored body' }]),
      msg('assistant', [
        { type: 'text', text: '已读取文件。' },
        { type: 'tool_use', id: '1', name: 'read_file', input: {} }
      ]),
      msg('user', '继续'),
      msg('assistant', [{ type: 'text', text: '第三段' }]),
      msg('user', '再问'),
      msg('assistant', [{ type: 'text', text: '第四段' }]),
      msg('user', '还问'),
      msg('assistant', [{ type: 'text', text: '第五段' }]),
      msg('user', '第六轮用户'),
      msg('assistant', [{ type: 'text', text: '不应出现' }])
    ]
    const out = buildTitleSuggestDialogueText(messages, 3)
    expect(out).toContain('用户：你好')
    expect(out).toContain('助手：你好，需要什么？')
    expect(out).toContain('助手：第三段')
    expect(out).not.toContain('第四段')
    expect(out).not.toContain('第五段')
    expect(out).not.toContain('第六轮用户')
    expect(out).not.toContain('不应出现')
    expect(out).not.toContain('ignored body')
  })
})

describe('reachedCumulativeAssistantTurnsForTitleSuggest', () => {
  it('口径 B：历史 + 本次 loopRound 累计 ≥3 即认为达标', () => {
    expect(reachedCumulativeAssistantTurnsForTitleSuggest(0, 3)).toBe(true)
    expect(reachedCumulativeAssistantTurnsForTitleSuggest(2, 1)).toBe(true)
    expect(reachedCumulativeAssistantTurnsForTitleSuggest(1, 2)).toBe(true)
    expect(reachedCumulativeAssistantTurnsForTitleSuggest(3, 1)).toBe(true)
    expect(reachedCumulativeAssistantTurnsForTitleSuggest(10, 1)).toBe(true)
    expect(reachedCumulativeAssistantTurnsForTitleSuggest(1, 1)).toBe(false)
    expect(reachedCumulativeAssistantTurnsForTitleSuggest(0, 2)).toBe(false)
  })
})

function stubAssistant(status: Message['status']): Message {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: 's',
    role: 'assistant',
    content: 'x',
    timestamp: 1,
    status,
    schemaVersion: CURRENT_SCHEMA_VERSION
  }
}

describe('countCompletedAssistantMessagesForTitleSuggest', () => {
  it('排除流式中的 assistant', () => {
    expect(countCompletedAssistantMessagesForTitleSuggest([stubAssistant('streaming')])).toBe(0)
    expect(countCompletedAssistantMessagesForTitleSuggest([stubAssistant('completed')])).toBe(1)
    expect(countCompletedAssistantMessagesForTitleSuggest([stubAssistant('completed'), stubAssistant('streaming')])).toBe(1)
  })
})
