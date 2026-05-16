import { describe, expect, it } from 'vitest'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import type { Message } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/domainTypes'
import {
  buildTitleSuggestDialogueText,
  reachedCumulativeAssistantTurnsForTitleSuggest,
  countCompletedAssistantMessagesForTitleSuggest
} from './sessionTitleSuggest'

function msg(role: 'user' | 'assistant', content: MessageParam['content']): MessageParam {
  return { role, content }
}

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
