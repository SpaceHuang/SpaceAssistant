import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { ChatBubble } from './ChatBubble'
import { changeAppLocale } from '../../i18n/localeSync'

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
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

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

  it('sets data-message-id on assistant bubble row', () => {
    render(
      <ChatBubble
        message={assistantMessage({
          id: 'assistant-42',
          status: 'completed',
          contentSegments: [{ content: 'Done', startTime: 1, endTime: 2 }]
        })}
      />
    )
    expect(document.querySelector('[data-message-id="assistant-42"]')).not.toBeNull()
  })

  it('sets data-message-id on user bubble row', () => {
    render(
      <ChatBubble
        message={{
          id: 'user-99',
          sessionId: 's1',
          role: 'user',
          content: 'question',
          timestamp: 1,
          status: 'sent',
          schemaVersion: 1
        }}
      />
    )
    expect(document.querySelector('[data-message-id="user-99"]')).not.toBeNull()
  })

  it('exposes aria-live region while assistant message is streaming', () => {
    render(<ChatBubble message={assistantMessage()} />)
    const region = document.querySelector('.chat-bubble-col--assistant')
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(region?.getAttribute('aria-busy')).toBe('true')
  })

  it('does not set aria-live when assistant message is completed', () => {
    const now = Date.now()
    render(
      <ChatBubble
        message={assistantMessage({
          status: 'completed',
          contentSegments: [{ content: 'Hello world', startTime: now, endTime: now }]
        })}
      />
    )
    const region = document.querySelector('.chat-bubble-col--assistant')
    expect(region?.getAttribute('aria-live')).toBeNull()
    expect(region?.getAttribute('aria-busy')).toBeNull()
  })

  it('shows retry action on failed assistant message', () => {
    const actions = {
      archiveToWiki: vi.fn(),
      retryAssistant: vi.fn(),
      cancelQueued: vi.fn(),
      confirmTool: vi.fn(),
      cancelTool: vi.fn()
    }
    const now = Date.now()
    render(
      <ChatBubble
        message={assistantMessage({
          status: 'failed',
          content: 'partial',
          contentSegments: [{ content: 'partial', startTime: now, endTime: now }]
        })}
        actions={actions}
        showRetry
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '重试回复' }))
    expect(actions.retryAssistant).toHaveBeenCalledWith('a1')
  })

  it('失败气泡在拿到失败原因时展示真实原因，而不是只留通用提示', () => {
    render(
      <ChatBubble
        message={assistantMessage({ status: 'failed' })}
        failureReason={'会话模型「claude-sonnet-4-20250514」当前不可用（未知模型），请在设置中重新选择模型'}
      />
    )
    expect(screen.getByText('失败原因')).toBeDefined()
    expect(screen.getByText(/会话模型「claude-sonnet-4-20250514」当前不可用/)).toBeDefined()
  })

  it('没有失败原因时只显示通用提示，不渲染空的原因行', () => {
    render(<ChatBubble message={assistantMessage({ status: 'failed' })} />)
    expect(screen.queryByText('失败原因')).toBeNull()
  })

  it('成功气泡即便带着失败原因也不展示', () => {
    render(<ChatBubble message={assistantMessage({ status: 'completed' })} failureReason="stale" />)
    expect(screen.queryByText('失败原因')).toBeNull()
    expect(screen.queryByText('stale')).toBeNull()
  })
})

describe('ChatBubble activity batch', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('groups multiple tools into activity batch summary row', () => {
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
    expect(document.querySelector('.activity-batch')).not.toBeNull()
    expect(screen.getByText(/app\.tsx 等 2 项/)).toBeDefined()
  })

  it('splits batches when text item interrupts timeline', () => {
    const now = Date.now()
    render(
      <ChatBubble
        message={assistantMessage({
          status: 'completed',
          content: 'answer',
          contentSegments: [{ content: 'answer', startTime: now + 50, endTime: now + 60 }],
          toolCalls: [
            {
              id: 't1',
              toolName: 'read_file',
              input: { path: 'a.txt' },
              status: 'completed',
              riskLevel: 'low',
              startedAt: now,
              completedAt: now + 1
            },
            {
              id: 't2',
              toolName: 'read_file',
              input: { path: 'b.txt' },
              status: 'completed',
              riskLevel: 'low',
              startedAt: now + 100,
              completedAt: now + 101
            }
          ]
        })}
      />
    )
    expect(document.querySelectorAll('.activity-batch').length).toBe(0)
    expect(document.querySelectorAll('.tool-row').length).toBe(2)
    expect(screen.getByText('answer')).toBeDefined()
  })

  it('does not wrap a single activity item in activity batch', () => {
    const now = Date.now()
    render(
      <ChatBubble
        message={assistantMessage({
          status: 'streaming',
          content: '',
          thinking: {
            content: 'think',
            isVisible: true,
            startTime: now,
            segments: [{ content: 'think', startTime: now }]
          },
          contentSegments: [],
          toolCalls: []
        })}
      />
    )
    expect(document.querySelector('.activity-batch')).toBeNull()
    expect(screen.getByText('思考')).toBeDefined()
  })

  it('keeps last batch expanded while streaming with in-progress tool', () => {
    const now = Date.now()
    render(
      <ChatBubble
        message={assistantMessage({
          status: 'streaming',
          content: '',
          contentSegments: [],
          toolCalls: [
            {
              id: 't1',
              toolName: 'read_file',
              input: { path: 'a.txt' },
              status: 'completed',
              riskLevel: 'low',
              startedAt: now,
              completedAt: now + 1
            },
            {
              id: 't2',
              toolName: 'read_file',
              input: { path: 'app.tsx' },
              status: 'executing',
              riskLevel: 'low',
              startedAt: now + 2
            }
          ]
        })}
      />
    )
    expect(document.querySelector('.activity-batch--expanded')).not.toBeNull()
  })

  it('invokes onCancelQueued when cancel button clicked', () => {
    const actions = {
      archiveToWiki: vi.fn(),
      retryAssistant: vi.fn(),
      cancelQueued: vi.fn(),
      confirmTool: vi.fn(),
      cancelTool: vi.fn()
    }
    render(
      <ChatBubble
        message={{
          id: 'u1',
          sessionId: 's1',
          role: 'user',
          content: 'follow up question',
          timestamp: Date.now(),
          status: 'queued',
          schemaVersion: 1
        }}
        actions={actions}
        showCancelQueued
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '取消排队' }))
    expect(actions.cancelQueued).toHaveBeenCalledWith('u1')
  })

  // ---- 活动批次稳定性（tool-row 整块闪动修复）：工具进入终态不得触发
  // 时间线重排，否则活动批次拆分/成员换位，批次内卡片整块跳动。
  it('工具进入终态后批次内工具卡顺序保持发起序不变', () => {
    const now = Date.now()
    const tools = (statuses: Array<'executing' | 'failed'>): Message['toolCalls'] =>
      statuses.map((status, i) => ({
        id: `t${i + 1}`,
        toolName: 'grep',
        input: {},
        status,
        riskLevel: 'low' as const,
        ...(status === 'failed' ? { completedAt: now + 50_000 + i * 1000 } : {})
      }))
    const { container, rerender } = render(
      <ChatBubble
        message={assistantMessage({ content: '', contentSegments: [], toolCalls: tools(['executing', 'executing', 'executing']) })}
      />
    )
    const ids = () => [...container.querySelectorAll('.tool-row__label')].map((n) => n.getAttribute('data-search-fragment-id'))
    expect(ids()).toEqual([
      expect.stringContaining('t1'),
      expect.stringContaining('t2'),
      expect.stringContaining('t3')
    ])
    rerender(
      <ChatBubble
        message={assistantMessage({ content: '', contentSegments: [], toolCalls: tools(['failed', 'failed', 'failed']) })}
      />
    )
    expect(ids()).toEqual([
      expect.stringContaining('t1'),
      expect.stringContaining('t2'),
      expect.stringContaining('t3')
    ])
  })

  // ---- DOM 防抖门禁：流式期间每次投影 flush 都以新引用重建消息对象（内容相同），
  // 终态工具卡（失败/完成）的 DOM 必须零变更——任何 text/attribute/childList 变更
  // 都会在 60fps 推送下表现为「卡片在抖」。
  it('流式期间每帧投影重建下,终态工具卡 DOM 零变更', async () => {
    const now = Date.now()
    const fixedTimestamp = now - 60_000
    const tools = (over: { t2Status: 'executing' | 'failed' }): Message['toolCalls'] => [
      {
        id: 't1',
        toolName: 'grep',
        input: {},
        status: 'failed',
        riskLevel: 'low',
        completedAt: now - 1000,
        result: { success: false, error: 'read-v1-target-unsupported', userMessage: 'V1 文件读取仅支持单个普通文件目标' }
      },
      {
        id: 't2',
        toolName: 'read_file',
        input: { path: 'a.txt' },
        status: over.t2Status,
        riskLevel: 'low'
      }
    ]
    const mkMessage = (t2Status: 'executing' | 'failed'): Message =>
      assistantMessage({ timestamp: fixedTimestamp, content: '', contentSegments: [{ content: '', startTime: fixedTimestamp }], toolCalls: tools({ t2Status }) })
    const { container, rerender } = render(<ChatBubble message={mkMessage('executing')} />)
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => mutations.push(...records))
    observer.observe(container, { subtree: true, childList: true, characterData: true, attributes: true })
    for (let frame = 0; frame < 10; frame++) {
      rerender(<ChatBubble message={mkMessage('executing')} />)
      await Promise.resolve()
      await Promise.resolve()
    }
    observer.disconnect()
    const summary = mutations.slice(0, 6).map((m) => ({
      type: m.type,
      target: (m.target as Element)?.className ?? String(m.target),
      name: m.attributeName ?? undefined
    }))
    expect(summary).toEqual([])
  })
})
