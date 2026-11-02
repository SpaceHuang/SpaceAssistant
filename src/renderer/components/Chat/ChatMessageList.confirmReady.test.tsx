import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'
import { ChatMessageList } from './ChatMessageList'
import type { PendingConfirmItem } from '../../services/pendingConfirmStore'
import { completedAssistantMessage, streamingAssistantMessage } from './testUtils/chatMessageFixtures'
import { toTurnDisplay } from '../../../shared/turnDisplayProtocol'
import { useTurnDisplay, useTurnDisplays } from '../../hooks/useTurnDisplay'
import type { AssistantActivityItem } from '../../../shared/assistantActivityTimeline'
import { resolveMessageToolsInteractive } from '../../services/resolveMessageToolsInteractive'

/**
 * J-03（docs/develop/chat-message-list-streaming-jitter-fix-plan.md）：
 * confirmationReadyByToolId 引用稳定化。同一份 pendingConfirmItems 下传给
 * 每行 ChatBubble 的对象引用必须稳定（否则 ChatBubble.memo 浅比较永远失效），
 * 同时值必须三态透传（undefined 不得归一为 false，见评审 B-01）。
 */

type BubbleProps = {
  message: Message
  displayActivity?: AssistantActivityItem[]
  confirmationReadyByToolId?: Record<string, boolean | undefined>
  toolsInteractive?: { requestId: string }
}

const bubblePropsLog: BubbleProps[] = []

vi.mock('./ChatBubble', () => ({
  ChatBubble: (props: BubbleProps) => {
    bubblePropsLog.push(props)
    return <div data-testid="bubble-mock" data-message-id={props.message.id} />
  }
}))

vi.mock('../../hooks/useTurnDisplay', () => ({
  useTurnDisplay: vi.fn(),
  useTurnDisplays: vi.fn(() => [])
}))

const mockedUseTurnDisplay = vi.mocked(useTurnDisplay)
const mockedUseTurnDisplays = vi.mocked(useTurnDisplays)

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
    mockedUseTurnDisplay.mockReset()
    mockedUseTurnDisplay.mockReturnValue(undefined)
    mockedUseTurnDisplays.mockReset()
    mockedUseTurnDisplays.mockReturnValue([])
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

  it('终态消息即使残留 pending item 也不渲染可交互确认卡', () => {
    const cancelled = streamingAssistantMessage({
      id: 'm-cancelled',
      status: 'cancelled',
      toolCalls: [{ id: 'tool-1', toolName: 'memory_wiki_restore_page', input: {}, status: 'confirming', riskLevel: 'medium' }]
    })
    const stalePending = makeItem({ requestId: 'r1', assistantMessageId: cancelled.id })

    render(
      <ChatMessageList
        messages={[cancelled]}
        pendingConfirmItems={[stalePending]}
        confirmationReadyBySession={{}}
        actions={undefined}
        resolveToolsInteractive={(message) => resolveMessageToolsInteractive({
          message,
          sessionId: message.sessionId,
          pendingItems: [stalePending],
          streamingRequestId: null
        })}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    expect(lastBubbleProps().message.toolCalls?.[0]?.status).toBe('failed')
    expect(lastBubbleProps().toolsInteractive).toBeUndefined()
  })

  it('中断终态期间在已取消的消息上继续展示已执行步骤', () => {
    const message = { ...streamingAssistantMessage({ id: 'm-cancelled-step', toolCalls: [] }), status: 'cancelled' as const }
    const display = toTurnDisplay({
      // Reproduce the handoff gap: persisted message is cancelled before turn display becomes terminal.
      turnId: 'turn-cancelled-step', requestId: 'request-cancelled-step', version: 4, lifecycle: 'streaming', outcome: 'cancelled',
      message: {
        ...streamingAssistantMessage({ id: 'm-cancelled-step', content: '[no content]' }),
        toolCalls: [
          { id: 'done-step', toolName: 'read_file', input: { path: 'README.md' }, status: 'completed', riskLevel: 'low', result: { success: true, data: 'read ok' } },
          { id: 'active-step', toolName: 'grep', input: { pattern: 'TODO' }, status: 'executing', riskLevel: 'low' }
        ]
      }
    })
    mockedUseTurnDisplay.mockReturnValue(display)

    render(
      <ChatMessageList
        messages={[message]}
        turnId="turn-cancelled-step"
        confirmationReadyBySession={{}}
        pendingConfirmItems={[]}
        actions={undefined}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    expect(lastBubbleProps().message.toolCalls?.map(({ id, status, interrupted }) => ({ id, status, interrupted }))).toEqual([
      { id: 'done-step', status: 'completed', interrupted: undefined },
      { id: 'active-step', status: 'failed', interrupted: true }
    ])
    expect(lastBubbleProps().message.content).toBe('')
  })

  it('canonical 已有工具调用时不让空的 turn-display activity 覆盖消息时间线', () => {
    const message = {
      ...streamingAssistantMessage({
        id: 'm-cancelled-canonical-tool',
        toolCalls: [{ id: 'persisted-tool', toolName: 'run_shell', input: { command: 'sleep 30' }, status: 'failed', riskLevel: 'high' }]
      }),
      status: 'cancelled' as const
    }
    mockedUseTurnDisplay.mockReturnValue(toTurnDisplay({
      turnId: 'turn-cancelled-canonical-tool', requestId: 'request-cancelled-canonical-tool', version: 4,
      lifecycle: 'failed', message: streamingAssistantMessage({ id: message.id, toolCalls: [
        { id: 'completed-display-tool', toolName: 'read_file', input: { path: 'README.md' }, status: 'completed', riskLevel: 'low', result: { success: true, data: 'read ok' } },
        { id: 'persisted-tool', toolName: 'run_shell', input: { command: 'sleep 30' }, status: 'executing', riskLevel: 'high' }
      ] })
    }))

    render(
      <ChatMessageList
        messages={[message]}
        turnId="turn-cancelled-canonical-tool"
        confirmationReadyBySession={{}}
        pendingConfirmItems={[]}
        actions={undefined}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    expect(lastBubbleProps().message.toolCalls?.map(({ id }) => id)).toEqual(['persisted-tool', 'completed-display-tool'])
    expect(lastBubbleProps().message.toolCalls?.find(({ id }) => id === 'completed-display-tool')).toMatchObject({
      input: { path: 'README.md' }, status: 'completed'
    })
    expect(lastBubbleProps().displayActivity).toContainEqual({ kind: 'tool', toolId: 'persisted-tool' })
  })

  it('中止先清除 runningSessions 时仍按 assistant message id 显示已执行步骤', () => {
    const assistantId = 'm-aborted-before-checkpoint'
    const message = {
      ...streamingAssistantMessage({ id: assistantId, toolCalls: [] }),
      status: 'cancelled' as const
    }
    const display = toTurnDisplay({
      turnId: 'turn-aborted-before-checkpoint', requestId: 'request-aborted-before-checkpoint', version: 9,
      lifecycle: 'failed', outcome: 'cancelled',
      message: streamingAssistantMessage({
        id: assistantId,
        toolCalls: [{ id: 'running-shell', toolName: 'run_shell', input: { command: 'sleep 30' }, status: 'executing', riskLevel: 'high' }]
      })
    })
    mockedUseTurnDisplays.mockReturnValue([display])

    render(
      <ChatMessageList
        messages={[message]}
        confirmationReadyBySession={{}}
        pendingConfirmItems={[]}
        actions={undefined}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    expect(lastBubbleProps().message.toolCalls?.map(({ id, status, interrupted }) => ({ id, status, interrupted }))).toEqual([
      { id: 'running-shell', status: 'failed', interrupted: true }
    ])
    expect(lastBubbleProps().displayActivity).toContainEqual({ kind: 'tool', toolId: 'running-shell' })
  })

  it('bounded display 更新已有工具记录时保留审批 Agent 标记', () => {
    const message = streamingAssistantMessage({
      id: 'm-agent',
      toolCalls: [{
        id: 'tool-agent',
        toolName: 'run_shell',
        input: { command: 'make deploy' },
        status: 'calling',
        riskLevel: 'high'
      }]
    })
    mockedUseTurnDisplay.mockReturnValue(toTurnDisplay({
      turnId: 'turn-agent',
      requestId: 'request-agent',
      version: 2,
      lifecycle: 'awaiting-confirmation',
      message: {
        ...message,
        toolCalls: [{ ...message.toolCalls![0]!, status: 'confirming', autoAnswerer: true }]
      }
    }))

    render(
      <ChatMessageList
        messages={[message]}
        turnId="turn-agent"
        confirmationReadyBySession={{}}
        pendingConfirmItems={[]}
        actions={undefined}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    expect(lastBubbleProps().message.toolCalls?.[0]).toMatchObject({ status: 'confirming', autoAnswerer: true })
  })

  it('bounded display 保留 IM 确认渠道以阻止桌面卡片交互', () => {
    const message = streamingAssistantMessage({
      id: 'm-feishu-confirm',
      toolCalls: [{
        id: 'tool-feishu', toolName: 'write_file', input: { path: 'notes.txt' }, status: 'calling', riskLevel: 'medium'
      }]
    })
    mockedUseTurnDisplay.mockReturnValue(toTurnDisplay({
      turnId: 'turn-feishu', requestId: 'request-feishu', version: 2, lifecycle: 'awaiting-confirmation',
      message: { ...message, toolCalls: [{ ...message.toolCalls![0]!, status: 'confirming', remoteConfirmation: 'feishu' }] }
    }))

    render(
      <ChatMessageList
        messages={[message]}
        turnId="turn-feishu"
        confirmationReadyBySession={{}}
        pendingConfirmItems={[]}
        actions={undefined}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    expect(lastBubbleProps().message.toolCalls?.[0]).toMatchObject({ status: 'confirming', remoteConfirmation: 'feishu' })
  })

  it('turn display 缺少已恢复 pending 工具时按原始发起时间补回活动顺序', () => {
    const message = streamingAssistantMessage({
      id: 'm-origin',
      content: 'checking',
      timestamp: 100,
      contentSegments: [{ content: 'checking', startTime: 100 }],
      toolCalls: [{
        id: 'later-tool', toolName: 'run_shell', input: {}, status: 'calling', riskLevel: 'low', startedAt: 300
      }],
      activity: [
        { kind: 'text', segmentIndex: 0 },
        { kind: 'tool', toolId: 'later-tool' }
      ]
    })
    const display = toTurnDisplay({
      turnId: 'turn-origin', requestId: 'request-origin', version: 3, lifecycle: 'running',
      message
    })
    mockedUseTurnDisplay.mockReturnValue(display)

    render(
      <ChatMessageList
        messages={[message]}
        turnId="turn-origin"
        confirmationReadyBySession={{}}
        pendingConfirmItems={[makeItem({
          toolUseId: 'missing-tool',
          toolName: 'run_script',
          assistantMessageId: 'm-origin',
          toolIndex: 0,
          activityIndex: 1,
          startedAt: 200
        })]}
        actions={undefined}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )

    expect(lastBubbleProps().message.toolCalls?.map((tool) => tool.id)).toEqual(['missing-tool', 'later-tool'])
    expect(lastBubbleProps().displayActivity).toEqual([
      { kind: 'text', segmentIndex: 0, contentStart: 0, contentEnd: 8 },
      { kind: 'tool', toolId: 'missing-tool' },
      { kind: 'tool', toolId: 'later-tool' }
    ])
  })
})
