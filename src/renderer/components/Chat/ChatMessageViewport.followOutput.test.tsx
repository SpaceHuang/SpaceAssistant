import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { ChatMessageViewport } from './ChatMessageViewport'
import { completedAssistantMessage } from './testUtils/chatMessageFixtures'

/**
 * J-02（docs/develop/chat-message-list-streaming-jitter-fix-plan.md）：
 * 流式跟随必须瞬时贴底。followOutput 返回 'smooth' 会在流式期间产生
 * 追赶式平滑动画（目标随内容增长持续移动），与 CSS/补偿滚动叠加造成整列表抖动。
 */

type FollowOutput = () => boolean | 'smooth' | 'auto'

const captured: { followOutput?: FollowOutput } = {}

vi.mock('react-virtuoso', () => {
  const ReactLocal = require('react') as typeof import('react')
  return {
    Virtuoso: ReactLocal.forwardRef(function VirtuosoMock(
      props: { followOutput?: FollowOutput },
      _ref: unknown
    ) {
      captured.followOutput = props.followOutput
      return <div data-testid="virtuoso-mock" />
    })
  }
})

function renderViewport(stickToBottom: boolean): void {
  render(
    <ChatMessageViewport
      messages={[completedAssistantMessage({ id: 'm-1' }) as Message]}
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
})
