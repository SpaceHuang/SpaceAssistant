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
})
