import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useMemo, useState } from 'react'
import type { Message, ShellConfig } from '../../../shared/domainTypes'
import { DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'
import { ChatMessageList } from './ChatMessageList'
import type { ChatMessageActions } from './ChatMessageActions'
import { ChatBubble } from './ChatBubble'
import {
  completedAssistantMessage,
  patchStreamingContent,
  streamingAssistantMessage,
  userMessage
} from './testUtils/chatMessageFixtures'
import { createRenderProbe } from './testUtils/renderProbe'

vi.mock('./ChatMarkdown', () => ({
  ChatMarkdown: ({ content }: { content: string }) => <div data-testid="chat-markdown">{content}</div>
}))

describe('ChatMessageList memo isolation', () => {
  const probe = createRenderProbe()

  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    probe.reset()
  })

  it('does not re-render completed history bubbles when streaming last message patches 100 times', () => {
    const history = completedAssistantMessage({ id: 'hist-1' })
    const streaming = streamingAssistantMessage({ id: 'stream-1', content: 'chunk-0' })
    const actions: ChatMessageActions = {
      archiveToWiki: vi.fn(),
      retryAssistant: vi.fn(),
      cancelQueued: vi.fn(),
      confirmTool: vi.fn(),
      cancelTool: vi.fn()
    }

    function Harness() {
      const [messages, setMessages] = useState<Message[]>([userMessage(), history, streaming])
      const stableActions = useMemo(() => actions, [])
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              setMessages((prev) => {
                const last = prev[prev.length - 1]!
                const next = patchStreamingContent(last, `${last.content}+`)
                return [...prev.slice(0, -1), next]
              })
            }}
          >
            patch
          </button>
          <ChatMessageList
            messages={messages}
            actions={stableActions}
            onBubbleRender={probe.track}
            resolveToolsInteractive={() => undefined}
            showArchiveToWiki={() => false}
            canRetry={() => false}
            canCancelQueued={() => false}
          />
        </div>
      )
    }

    render(<Harness />)
    const historyRendersAfterMount = probe.get('hist-1')
    expect(historyRendersAfterMount).toBeGreaterThan(0)

    for (let i = 0; i < 100; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'patch' }))
    }

    expect(probe.get('hist-1')).toBe(historyRendersAfterMount)
    expect(probe.get('stream-1')).toBeGreaterThan(historyRendersAfterMount)
  })

  it('re-renders bubbles when workDir changes', () => {
    const msg = completedAssistantMessage({ id: 'hist-1' })
    const actions: ChatMessageActions = {
      archiveToWiki: vi.fn(),
      retryAssistant: vi.fn(),
      cancelQueued: vi.fn(),
      confirmTool: vi.fn(),
      cancelTool: vi.fn()
    }

    const { rerender } = render(
      <ChatMessageList
        messages={[msg]}
        actions={actions}
        workDir="/a"
        onBubbleRender={probe.track}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )
    const afterFirst = probe.get('hist-1')
    rerender(
      <ChatMessageList
        messages={[msg]}
        actions={actions}
        workDir="/b"
        onBubbleRender={probe.track}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )
    expect(probe.get('hist-1')).toBeGreaterThan(afterFirst)
  })

  it('re-renders bubbles when shellConfig changes', () => {
    const msg = completedAssistantMessage({ id: 'hist-1' })
    const actions: ChatMessageActions = {
      archiveToWiki: vi.fn(),
      retryAssistant: vi.fn(),
      cancelQueued: vi.fn(),
      confirmTool: vi.fn(),
      cancelTool: vi.fn()
    }
    const shellA: ShellConfig = { ...DEFAULT_SHELL_CONFIG }
    const shellB: ShellConfig = { ...DEFAULT_SHELL_CONFIG, shellDefaultTimeoutSec: 99 }

    const { rerender } = render(
      <ChatMessageList
        messages={[msg]}
        actions={actions}
        shellConfig={shellA}
        onBubbleRender={probe.track}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )
    const afterFirst = probe.get('hist-1')
    rerender(
      <ChatMessageList
        messages={[msg]}
        actions={actions}
        shellConfig={shellB}
        onBubbleRender={probe.track}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={() => false}
        canCancelQueued={() => false}
      />
    )
    expect(probe.get('hist-1')).toBeGreaterThan(afterFirst)
  })

  it('passes message id through retry and cancelQueued actions', () => {
    const retryAssistant = vi.fn()
    const cancelQueued = vi.fn()
    const actions: ChatMessageActions = {
      archiveToWiki: vi.fn(),
      retryAssistant,
      cancelQueued,
      confirmTool: vi.fn(),
      cancelTool: vi.fn()
    }

    const failed = completedAssistantMessage({
      id: 'fail-1',
      status: 'failed',
      content: 'oops'
    })
    const queued = userMessage({ id: 'q-1', status: 'queued', content: 'waiting' })

    render(
      <ChatMessageList
        messages={[failed, queued]}
        actions={actions}
        resolveToolsInteractive={() => undefined}
        showArchiveToWiki={() => false}
        canRetry={(m) => m.status === 'failed'}
        canCancelQueued={(m) => m.status === 'queued'}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '重试回复' }))
    expect(retryAssistant).toHaveBeenCalledWith('fail-1')

    fireEvent.click(screen.getByRole('button', { name: '取消排队' }))
    expect(cancelQueued).toHaveBeenCalledWith('q-1')
  })
})

describe('ChatBubble actions binding', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('calls actions.retryAssistant with message id', () => {
    const actions: ChatMessageActions = {
      archiveToWiki: vi.fn(),
      retryAssistant: vi.fn(),
      cancelQueued: vi.fn(),
      confirmTool: vi.fn(),
      cancelTool: vi.fn()
    }
    render(
      <ChatBubble
        message={completedAssistantMessage({ id: 'fail-9', status: 'failed', content: 'x' })}
        actions={actions}
        showRetry
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '重试回复' }))
    expect(actions.retryAssistant).toHaveBeenCalledWith('fail-9')
  })

  it('calls actions.archiveToWiki with message content', () => {
    const actions: ChatMessageActions = {
      archiveToWiki: vi.fn(),
      retryAssistant: vi.fn(),
      cancelQueued: vi.fn(),
      confirmTool: vi.fn(),
      cancelTool: vi.fn()
    }
    render(
      <ChatBubble
        message={completedAssistantMessage({ id: 'a', content: 'wiki body' })}
        actions={actions}
        showArchiveToWiki
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '归档到 Wiki' }))
    expect(actions.archiveToWiki).toHaveBeenCalledWith('wiki body')
  })
})
