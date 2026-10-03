import { describe, expect, it } from 'vitest'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import type { Message } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/domainTypes'
import {
  buildTitleSuggestDialogueText,
  countVisibleTitleMessagesForSuggest,
  formatTitleDialogueLabel,
  getTitleSystemPrompt,
  reachedCumulativeMessagesForTitleSuggest,
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
    const out = buildTitleSuggestDialogueText(messages, 2, 'en-US')
    expect(out).toContain('User: hello')
    expect(out).toContain('Assistant: hi there')
  })

  it('T4: zh-CN uses 用户： / 助手： prefixes', () => {
    const out = buildTitleSuggestDialogueText(messages, 2, 'zh-CN')
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
  it('工具调用与工具回执不占配额，摘要保留第三条可见消息', () => {
    const messages: MessageParam[] = [
      msg('user', '问题 A'),
      msg('assistant', [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: '文件内容' }]),
      msg('assistant', [{ type: 'text', text: '回答 A' }]),
      msg('user', '问题 B')
    ]
    const out = buildTitleSuggestDialogueText(messages, 3)
    expect(countVisibleTitleMessagesForSuggest(messages)).toBe(3)
    expect(out).toContain('问题 B')
    expect(out).not.toContain('文件内容')
  })

  it('strips tool blocks and stops after N visible user/assistant messages', () => {
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
    expect(out).toContain('助手：你好，需要什么？')
    expect(out).toContain('用户：你好')
    expect(out).not.toContain('第三段')
    expect(out).not.toContain('第四段')
    expect(out).not.toContain('不应出现')
    expect(out).not.toContain('ignored body')
  })
})

describe('reachedCumulativeMessagesForTitleSuggest', () => {
  it('user + assistant 消息总数达到 3 条即达标', () => {
    expect(reachedCumulativeMessagesForTitleSuggest(0, 3)).toBe(true)
    expect(reachedCumulativeMessagesForTitleSuggest(2, 1)).toBe(true)
    expect(reachedCumulativeMessagesForTitleSuggest(1, 1)).toBe(false)
    expect(reachedCumulativeMessagesForTitleSuggest(3, 0)).toBe(true)
    expect(reachedCumulativeMessagesForTitleSuggest(10, 1)).toBe(true)
    expect(reachedCumulativeMessagesForTitleSuggest(0, 1)).toBe(false)
    expect(reachedCumulativeMessagesForTitleSuggest(1, 1)).toBe(false)
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
