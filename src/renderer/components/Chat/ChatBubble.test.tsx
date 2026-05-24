import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { ChatBubble } from './ChatBubble'

const chatMarkdownRenderCount = vi.fn()

vi.mock('./ChatMarkdown', () => ({
  ChatMarkdown: ({ content }: { content: string }) => {
    chatMarkdownRenderCount()
    return <div data-testid="chat-markdown">{content}</div>
  }
}))

function assistantMessage(over: Partial<Message> = {}): Message {
  const now = Date.now()
  return {
    id: 'a1',
    sessionId: 's1',
    role: 'assistant',
    content: 'Hello world',
    timestamp: now,
    status: 'streaming',
    schemaVersion: 1,
    contentSegments: [{ content: 'Hello world', startTime: now }],
    ...over
  }
}

describe('ChatBubble streaming render', () => {
  it('uses plain text while streaming', () => {
    chatMarkdownRenderCount.mockClear()
    render(<ChatBubble message={assistantMessage()} />)
    expect(document.querySelector('.chat-stream-plain')).not.toBeNull()
    expect(screen.getByText('Hello world')).toBeDefined()
    expect(screen.queryByTestId('chat-markdown')).toBeNull()
    expect(chatMarkdownRenderCount).not.toHaveBeenCalled()
  })

  it('uses ChatMarkdown when completed', () => {
    chatMarkdownRenderCount.mockClear()
    const now = Date.now()
    render(
      <ChatBubble
        message={assistantMessage({
          status: 'completed',
          contentSegments: [{ content: 'Hello world', startTime: now, endTime: now }]
        })}
      />
    )
    expect(document.querySelector('.chat-stream-plain')).toBeNull()
    expect(screen.getByTestId('chat-markdown')).toBeDefined()
    expect(chatMarkdownRenderCount).toHaveBeenCalled()
  })

  it('skips re-render when memo props are unchanged', () => {
    chatMarkdownRenderCount.mockClear()
    const msg = assistantMessage({
      status: 'completed',
      contentSegments: [{ content: 'Done', startTime: 1, endTime: 2 }]
    })
    const { rerender } = render(<ChatBubble message={msg} />)
    const afterFirst = chatMarkdownRenderCount.mock.calls.length
    rerender(<ChatBubble message={msg} />)
    expect(chatMarkdownRenderCount.mock.calls.length).toBe(afterFirst)
  })
})
