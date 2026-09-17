import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'
import { ChatMessageList } from './ChatMessageList'
import type { PendingConfirmItem } from '../../services/pendingConfirmStore'
import { completedAssistantMessage } from './testUtils/chatMessageFixtures'

/**
 * J-03（docs/develop/chat-message-list-streaming-jitter-fix-plan.md）：
 * confirmationReadyByToolId 引用稳定化。同一份 pendingConfirmItems 下传给
 * 每行 ChatBubble 的对象引用必须稳定（否则 ChatBubble.memo 浅比较永远失效），
 * 同时值必须三态透传（undefined 不得归一为 false，见评审 B-01）。
 */

type BubbleProps = {
  message: Message
  confirmationReadyByToolId?: Record<string, boolean | undefined>
}

const bubblePropsLog: BubbleProps[] = []

vi.mock('./ChatBubble', () => ({
  ChatBubble: (props: BubbleProps) => {
    bubblePropsLog.push(props)
    return <div data-testid="bubble-mock" data-message-id={props.message.id} />
  }
}))

function makeItem(overrides: Partial<PendingConfirmItem>): PendingConfirmItem {
  return {
    sessionId: 's1',
    requestId: 'r1',
    toolUseId: 'tool-1',
    toolName: 'write_file',
    input: {},
    riskLevel: 'medium',
    createdAt: 1,
    ...overrides
  } as PendingConfirmItem
}

function renderList(props: {
  messages?: Message[]
  pendingConfirmItems?: PendingConfirmItem[]
  confirmationReadyBySession?: Record<string, Record<string, boolean | undefined>>
}): void {
  render(
    <ChatMessageList
      messages={props.messages ?? [completedAssistantMessage({ id: 'm-1' })]}
      pendingConfirmItems={props.pendingConfirmItems ?? []}
      confirmationReadyBySession={props.confirmationReadyBySession ?? {}}
      actions={undefined}
      resolveToolsInteractive={() => undefined}
      showArchiveToWiki={() => false}
      canRetry={() => false}
      canCancelQueued={() => false}
    />
  )
}

function lastBubbleProps(): BubbleProps {
  expect(bubblePropsLog.length).toBeGreaterThan(0)
  return bubblePropsLog[bubblePropsLog.length - 1]!
}

describe('ChatMessageList confirmationReadyByToolId stability', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    bubblePropsLog.length = 0
  })

  it('同一 pendingConfirmItems 引用下重渲染，行内收到的 confirmationReadyByToolId 引用不变', () => {
    const items = [makeItem({})]
    const bySession = { s1: { 'tool-1': false } }

    const harness = (key: string) => (
      <ChatMessageList
        key={key}
        messages={[completedAssistantMessage({ id: 'm-1' })]}
        pendingConfirmItems={items}
        confirmationReadyBySession={bySession}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    const { rerender } = render(harness('a'))
    const first = lastBubbleProps().confirmationReadyByToolId
    rerender(harness('b'))
    const second = lastBubbleProps().confirmationReadyByToolId

    expect(first).toBe(bySession.s1)
    expect(second).toBe(first)
  })

  it('confirmationReady 翻转后，行内收到新引用与新值', () => {
    const before = { s1: { 'tool-1': false } }
    const after = { s1: { 'tool-1': true } }

    const harness = (ready: Record<string, Record<string, boolean | undefined>>) => (
      <ChatMessageList
        messages={[completedAssistantMessage({ id: 'm-1' })]}
        pendingConfirmItems={[makeItem({})]}
        confirmationReadyBySession={ready}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    const { rerender } = render(harness(before))
    const first = lastBubbleProps().confirmationReadyByToolId
    rerender(harness(after))
    const second = lastBubbleProps().confirmationReadyByToolId

    expect(second).not.toBe(first)
    expect(second?.['tool-1']).toBe(true)
  })

  it('pendingConfirmItems 为空数组时行内收到稳定空对象（两次渲染同一引用）', () => {
    // 模拟 pendingConfirmItems 为空：ChatView 的 useMemo 产出空 map（两次渲染新字面量），
    // 行内应走 `?? EMPTY_CONFIRM_READY` 模块常量兜底，收到同一引用。
    const harness = (key: string) => (
      <ChatMessageList
        key={key}
        messages={[completedAssistantMessage({ id: 'm-1' })]}
        pendingConfirmItems={[]}
        confirmationReadyBySession={{}}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    const { rerender } = render(harness('a'))
    const first = lastBubbleProps().confirmationReadyByToolId
    rerender(harness('b'))
    const second = lastBubbleProps().confirmationReadyByToolId

    expect(first).toEqual({})
    expect(second).toBe(first)
  })

  it('（评审 B-01）confirmationReady 为 undefined 的 item 透传后仍为 undefined 而非 false', () => {
    // confirmationReady 字段缺省（三态中的"未知/旧路径"）：
    // 下游 ToolCallCard 门禁为 confirmationReady !== false，undefined 必须原样保留。
    const bySession = { s1: { 'tool-1': undefined } }

    renderList({
      pendingConfirmItems: [makeItem({})],
      confirmationReadyBySession: bySession
    })

    const received = lastBubbleProps().confirmationReadyByToolId
    expect('tool-1' in (received ?? {})).toBe(true)
    expect(received?.['tool-1']).toBeUndefined()
    expect(received?.['tool-1']).not.toBe(false)
  })
})
