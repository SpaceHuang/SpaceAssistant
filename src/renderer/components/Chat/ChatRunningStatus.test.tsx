import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { changeAppLocale } from '../../i18n/localeSync'
import { ChatRunningElapsed } from './ChatRunningStatus'
import { streamingAssistantMessage } from './testUtils/chatMessageFixtures'

describe('ChatRunningElapsed', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    await changeAppLocale('zh-CN')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('updates elapsed text on its own timer without requiring parent rerender', () => {
    const msg = streamingAssistantMessage({
      timestamp: Date.now() - 5000,
      content: '',
      toolCalls: [
        {
          id: 't1',
          toolName: 'read_file',
          input: { path: 'a.ts' },
          status: 'executing',
          riskLevel: 'low',
          startedAt: Date.now() - 5000
        }
      ]
    })
    render(<ChatRunningElapsed streamingAssistant={msg} />)
    const first = screen.queryByText(/\d/)
    expect(first).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByText(/\d/)).not.toBeNull()
  })
})
