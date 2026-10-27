import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { ChatMessageViewport } from './ChatMessageViewport'
import { completedAssistantMessage } from './testUtils/chatMessageFixtures'

/**
 * J-02（docs/develop/chat-message-list-streaming-jitter-fix-plan.md）：
 * 流式跟随必须瞬时贴底。followOutput 返回 'smooth' 会在流式期间产生
 * 追赶式平滑动画（目标随内容增长持续移动），与 CSS/补偿滚动叠加造成整列表抖动。
 */

type FollowOutput = () => boolean | 'smooth' | 'auto'

const captured: { followOutput?: FollowOutput; firstItemIndex?: number } = {}

vi.mock('react-virtuoso', () => {
  const ReactLocal = require('react') as typeof import('react')
  return {
    Virtuoso: ReactLocal.forwardRef(function VirtuosoMock(
      props: { followOutput?: FollowOutput; firstItemIndex?: number },
      _ref: unknown
    ) {
      captured.followOutput = props.followOutput
      captured.firstItemIndex = props.firstItemIndex
      return <div data-testid="virtuoso-mock" />
    })
  }
})

function renderViewport(stickToBottom: boolean, sessionId = 's1', messages = [completedAssistantMessage({ id: 'm-1' }) as Message]) {
  return render(
    <ChatMessageViewport
      sessionId={sessionId}
      messages={messages}
      stickToBottom={stickToBottom}
      onStickToBottomChange={vi.fn()}
      scrollToLatestMounted={false}
      showScrollToLatest={false}
      scrollToLatestLabel="scroll to latest"
      scrollToLatestIconHtml=""
      onScrollToLatest={vi.fn()}
      renderMessage={() => <div />}
    />
  )
}

describe('ChatMessageViewport followOutput', () => {
  beforeEach(() => {
    captured.followOutput = undefined
  })

  it('贴底时返回布尔 true（瞬时贴底，禁止 smooth 动画）', () => {
    renderViewport(true)
    expect(captured.followOutput).toBeTypeOf('function')
    expect(captured.followOutput!()).toBe(true)
  })

  it('离开底部时返回 false（不跟随）', () => {
    renderViewport(false)
    expect(captured.followOutput!()).toBe(false)
  })

  it('切换到消息更多的新会话时重置首项索引，不把新会话误判为 prepend', async () => {
    const oldMessages = [
      completedAssistantMessage({ id: 'old-1', sessionId: 'old' }) as Message,
      completedAssistantMessage({ id: 'old-2', sessionId: 'old' }) as Message
    ]
    const newMessages = [
      completedAssistantMessage({ id: 'new-1', sessionId: 'new' }) as Message,
      completedAssistantMessage({ id: 'new-2', sessionId: 'new' }) as Message,
      completedAssistantMessage({ id: 'new-3', sessionId: 'new' }) as Message
    ]
    const view = renderViewport(true, 'old', oldMessages)

    view.rerender(
      <ChatMessageViewport
        sessionId="new"
        messages={oldMessages}
        stickToBottom
        onStickToBottomChange={vi.fn()}
        scrollToLatestMounted={false}
        showScrollToLatest={false}
        scrollToLatestLabel="scroll to latest"
        scrollToLatestIconHtml=""
        onScrollToLatest={vi.fn()}
        renderMessage={() => <div />}
      />
    )
    view.rerender(
      <ChatMessageViewport
        sessionId="new"
        messages={newMessages}
        stickToBottom
        onStickToBottomChange={vi.fn()}
        scrollToLatestMounted={false}
        showScrollToLatest={false}
        scrollToLatestLabel="scroll to latest"
        scrollToLatestIconHtml=""
        onScrollToLatest={vi.fn()}
        renderMessage={() => <div />}
      />
    )

    await waitFor(() => expect(captured.firstItemIndex).toBe(100_000))
  })

  it('同一会话向前翻页时仍按插入消息数补偿首项索引', async () => {
    const currentMessages = [
      completedAssistantMessage({ id: 'm-1', sessionId: 's1' }) as Message,
      completedAssistantMessage({ id: 'm-2', sessionId: 's1' }) as Message
    ]
    const view = renderViewport(true, 's1', currentMessages)
    const prependedMessages = [
      completedAssistantMessage({ id: 'older', sessionId: 's1' }) as Message,
      ...currentMessages
    ]

    view.rerender(
      <ChatMessageViewport
        sessionId="s1"
        messages={prependedMessages}
        stickToBottom
        onStickToBottomChange={vi.fn()}
        scrollToLatestMounted={false}
        showScrollToLatest={false}
        scrollToLatestLabel="scroll to latest"
        scrollToLatestIconHtml=""
        onScrollToLatest={vi.fn()}
        renderMessage={() => <div />}
      />
    )

    await waitFor(() => expect(captured.firstItemIndex).toBe(99_999))
  })
})
