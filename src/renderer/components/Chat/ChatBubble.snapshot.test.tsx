import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { assistantMessage, toolUse } from '../../../test/factories/message'
import { ChatBubble } from './ChatBubble'
import { changeAppLocale } from '../../i18n/localeSync'

describe('ChatBubble snapshots', () => {
  it('snapshots text, thinking, and tool-call render states', async () => {
    await changeAppLocale('en-US')
    const timestamp = 1_700_000_000_000
    const thinkingMessage = assistantMessage({
      id: 'snapshot-thinking', sessionId: 'snapshot-session', content: '', contentSegments: [], status: 'completed', timestamp,
      thinking: { content: 'Check the result before replying.', isVisible: true, startTime: timestamp, endTime: timestamp + 1 }
    })
    const toolMessage = assistantMessage({
      id: 'snapshot-tool', sessionId: 'snapshot-session', content: '', contentSegments: [], status: 'completed', timestamp,
      toolCalls: [toolUse({ id: 'snapshot-read', toolName: 'read_file', input: { path: 'src/app.ts' }, status: 'completed', startedAt: timestamp, completedAt: timestamp + 3 })]
    })
    const longText = 'Long response text. '.repeat(48)
    const longMessage = assistantMessage({
      id: 'snapshot-long', sessionId: 'snapshot-session', content: longText, status: 'completed', timestamp,
      contentSegments: [{ content: longText, startTime: timestamp, endTime: timestamp + 5 }]
    })
    const { container } = render(<>
      <ChatBubble message={thinkingMessage} />
      <ChatBubble message={toolMessage} />
      <ChatBubble message={longMessage} />
    </>)
    container.querySelectorAll('.chat-bubble-meta').forEach((meta) => meta.remove())
    expect(container).toMatchSnapshot()
  })
})
