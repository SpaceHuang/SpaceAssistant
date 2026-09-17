import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'
import { ChatMessageList } from './ChatMessageList'
import type { ChatMessageActions } from './ChatMessageActions'

vi.mock('./ChatMarkdown', () => ({
  ChatMarkdown: ({ content }: { content: string }) => <div data-testid="chat-markdown">{content}</div>
}))

const actions: ChatMessageActions = {
  archiveToWiki: vi.fn(),
  retryAssistant: vi.fn(),
  cancelQueued: vi.fn(),
  confirmTool: vi.fn(),
  cancelTool: vi.fn()
}

function failedMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'a-fail',
    sessionId: 's1',
    role: 'assistant',
    content: 'partial',
    timestamp: 1,
    status: 'failed',
    schemaVersion: 1,
    ...over
  }
}

function renderList(messages: Message[], resolveFailureReason?: (m: Message) => string | undefined) {
  return render(
    <ChatMessageList
      messages={messages}
      actions={actions}
      confirmationReadyBySession={{}}
      resolveToolsInteractive={() => undefined}
      showArchiveToWiki={() => false}
      canRetry={() => false}
      canCancelQueued={() => false}
      {...(resolveFailureReason ? { resolveFailureReason } : {})}
    />
  )
}

describe('ChatMessageList 失败原因透传', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('按消息解析失败原因并传给对应气泡', () => {
    renderList([failedMessage()], (m) => (m.id === 'a-fail' ? '模型不可用' : undefined))
    expect(screen.getByText('失败原因')).toBeDefined()
    expect(screen.getByText('模型不可用')).toBeDefined()
  })

  it('未提供解析器时不渲染原因行', () => {
    renderList([failedMessage()])
    expect(screen.queryByText('失败原因')).toBeNull()
  })

  it('解析器对其它消息返回空时不串原因', () => {
    renderList([failedMessage({ id: 'a-other' })], () => undefined)
    expect(screen.queryByText('失败原因')).toBeNull()
  })
})
