import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { ChatBubble } from './ChatBubble'
import { ThinkingBlock } from './ThinkingBlock'
import { changeAppLocale } from '../../i18n/localeSync'

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

describe('chat i18n', () => {
  beforeEach(async () => {
    await changeAppLocale('en-US')
  })

  it('ChatBubble meta shows English streaming status', () => {
    render(<ChatBubble message={assistantMessage()} />)
    expect(screen.getByText('Generating')).toBeDefined()
  })

  it('ThinkingBlock label is English', () => {
    render(<ThinkingBlock content="inner monologue" active={false} />)
    expect(screen.getByText('Thinking')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Expand thinking' })).toBeDefined()
  })

  it('ActivityBatch summary uses English count label', () => {
    const now = Date.now()
    render(
      <ChatBubble
        message={assistantMessage({
          status: 'completed',
          content: '',
          contentSegments: [],
          toolCalls: [
            {
              id: 't1',
              toolName: 'read_file',
              input: { path: 'app.tsx' },
              status: 'completed',
              riskLevel: 'low',
              startedAt: now,
              completedAt: now + 1
            },
            {
              id: 't2',
              toolName: 'edit_file',
              input: { path: 'app.tsx' },
              status: 'completed',
              riskLevel: 'low',
              startedAt: now + 2,
              completedAt: now + 3
            }
          ]
        })}
      />
    )
    expect(screen.getByText(/app\.tsx and 2 more/)).toBeDefined()
  })
})
