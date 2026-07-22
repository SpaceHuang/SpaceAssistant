import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Message, ToolCallRecord } from '../../../shared/domainTypes'
import { ChatBubble } from '../components/Chat/ChatBubble'
import { ChatMarkdown } from '../components/Chat/ChatMarkdown'
import {
  applyActiveTargetHighlight,
  resolveChatSearchActiveTarget
} from './chatSearchActiveTarget'
import { searchChatMessageEntries } from './chatStructuredSearchAdapter'

function assistantWithThinking(): Message {
  return {
    id: 'asst-1',
    sessionId: 's1',
    role: 'assistant',
    content: 'visible answer',
    timestamp: 2,
    status: 'completed',
    schemaVersion: 1,
    contentSegments: [{ content: 'visible answer', startTime: 2, endTime: 3 }],
    thinking: {
      content: 'unique-thinking-needle',
      isVisible: true,
      startTime: 1,
      segments: [{ content: 'unique-thinking-needle', startTime: 1, endTime: 2 }]
    }
  }
}

function assistantWithTool(): Message {
  const tool: ToolCallRecord = {
    id: 'tool-1',
    toolName: 'read_file',
    input: { path: 'secret-input-path.ts' },
    status: 'completed',
    riskLevel: 'low',
    result: { success: true, data: 'secret-result-body' }
  }
  return {
    id: 'asst-tool',
    sessionId: 's1',
    role: 'assistant',
    content: 'done',
    timestamp: 2,
    status: 'completed',
    schemaVersion: 1,
    contentSegments: [{ content: 'done', startTime: 2, endTime: 3 }],
    toolCalls: [tool]
  }
}

describe('chat search reveal + fragment highlight (review v3)', () => {
  it('thinking unique hit expands and highlights correct range', () => {
    const message = assistantWithThinking()
    const entries = [{ message, order: { kind: 'persisted' as const, sequence: 1 } }]
    const result = searchChatMessageEntries(entries, 'unique-thinking-needle', {
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    })
    expect(result.matches).toHaveLength(1)
    const target = resolveChatSearchActiveTarget(result.matches[0], result.fragments)
    expect(target?.revealPath).toEqual({ thinkingSegmentIndex: 0 })

    render(<ChatBubble message={message} activeSearchTarget={target} />)
    expect(document.querySelector('.chat-thinking--expanded')).not.toBeNull()
    const mark = applyActiveTargetHighlight(document.body, target!)
    expect(mark?.closest('[data-search-fragment-id]')?.getAttribute('data-search-fragment-id')).toBe(
      target!.fragmentId
    )
    expect(mark?.textContent).toContain('unique')
  })

  it('tool result hit expands section; clearing activeTarget restores collapsed', () => {
    const message = assistantWithTool()
    const entries = [{ message, order: { kind: 'persisted' as const, sequence: 1 } }]
    const result = searchChatMessageEntries(entries, 'secret-result-body', {
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    })
    expect(result.matches.length).toBeGreaterThan(0)
    const target = resolveChatSearchActiveTarget(result.matches[0], result.fragments)
    expect(target?.revealPath?.toolSection).toBe('result')

    const { rerender } = render(<ChatBubble message={message} activeSearchTarget={target} />)
    expect(document.querySelector('.tool-row--expanded')).not.toBeNull()
    expect(
      document.querySelector(`[data-search-fragment-id="${target!.fragmentId}"]`)?.textContent
    ).toContain('secret-result-body')

    rerender(<ChatBubble message={message} activeSearchTarget={null} />)
    expect(document.querySelector('.tool-row--expanded')).toBeNull()
  })

  it('tool input hit expands and shows input fragment even when result exists', () => {
    const message = assistantWithTool()
    const entries = [{ message, order: { kind: 'persisted' as const, sequence: 1 } }]
    const result = searchChatMessageEntries(entries, 'secret-input-path', {
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    })
    const inputMatch = result.matches.find((m) => m.fragmentId.includes('tool-input'))
    expect(inputMatch).toBeDefined()
    const target = resolveChatSearchActiveTarget(inputMatch, result.fragments)
    expect(target?.revealPath?.toolSection).toBe('input')

    render(<ChatBubble message={message} activeSearchTarget={target} />)
    expect(document.querySelector('.tool-row--expanded')).not.toBeNull()
    expect(
      document.querySelector(`[data-search-fragment-id="${target!.fragmentId}"]`)?.textContent
    ).toContain('secret-input-path')
  })

  it('interleaved markdown text/code/math switch by fragmentId + range', () => {
    const markdown = 'Hello PLAIN_HIT with `CODE_HIT` and $MATH_HIT$'
    const message: Message = {
      id: 'asst-md',
      sessionId: 's1',
      role: 'assistant',
      content: markdown,
      timestamp: 1,
      status: 'completed',
      schemaVersion: 1,
      contentSegments: [{ content: markdown, startTime: 1, endTime: 2 }]
    }
    const entries = [{ message, order: { kind: 'persisted' as const, sequence: 1 } }]
    const result = searchChatMessageEntries(entries, 'HIT', {
      caseSensitive: true,
      wholeWord: false,
      useRegex: false
    })
    expect(result.matches.length).toBeGreaterThanOrEqual(3)

    const byKind = (kind: string) =>
      result.matches.find((m) => {
        const f = result.fragments.find((x) => x.fragmentId === m.fragmentId)
        return f?.source.kind === kind
      })

    const plain = byKind('assistant-markdown-text')!
    const code = byKind('assistant-code')!
    const math = byKind('assistant-math')!
    expect(plain && code && math).toBeTruthy()

    const plainTarget = resolveChatSearchActiveTarget(plain, result.fragments)!
    const codeTarget = resolveChatSearchActiveTarget(code, result.fragments)!
    const mathTarget = resolveChatSearchActiveTarget(math, result.fragments)!

    const { rerender } = render(
      <ChatMarkdown
        content={markdown}
        messageId={message.id}
        segmentIndex={0}
        activeSearchTarget={codeTarget}
      />
    )
    expect(
      document
        .querySelector('mark.sa-search-highlight-current')
        ?.closest('[data-search-fragment-id]')
        ?.getAttribute('data-search-fragment-id')
    ).toBe(codeTarget.fragmentId)

    rerender(
      <ChatMarkdown
        content={markdown}
        messageId={message.id}
        segmentIndex={0}
        activeSearchTarget={mathTarget}
      />
    )
    expect(
      document
        .querySelector('[data-search-fragment-id][aria-current="true"]')
        ?.getAttribute('data-search-fragment-id')
    ).toBe(mathTarget.fragmentId)

    rerender(
      <ChatMarkdown
        content={markdown}
        messageId={message.id}
        segmentIndex={0}
        activeSearchTarget={plainTarget}
      />
    )
    const mark = applyActiveTargetHighlight(document.body, plainTarget)
    expect(mark?.textContent).toBe('HIT')
    expect(mark?.closest('[data-search-fragment-id]')?.getAttribute('data-search-fragment-id')).toBe(
      plainTarget.fragmentId
    )
  })
})
