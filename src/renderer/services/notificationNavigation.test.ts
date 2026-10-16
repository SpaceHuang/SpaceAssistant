import { beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store'
import { setConfig } from '../store/configSlice'
import { setSessions } from '../store/sessionSlice'
import { resetChatUi, setMessages, setSession } from '../store/chatSlice'
import { pendingConfirmStore } from './pendingConfirmStore'
import { handleRemoteSessionSwitch } from './remoteSessionSwitchService'
import type { Message, Session } from '../../shared/domainTypes'

function session(id: string): Session {
  return { id, name: id, preview: '', model: 'm', temperature: 1, maxTokens: 100, createdAt: 1, updatedAt: 1, messageCount: 1, schemaVersion: 1 }
}

describe('floating confirmation notification navigation', () => {
  beforeEach(() => {
    store.dispatch(resetChatUi())
    store.dispatch(setSessions([session('target'), session('target-a'), session('target-b')]))
    store.dispatch(setConfig({ workDir: '/tmp', workDirProfiles: [{ id: 'p1', name: 'tmp', path: '/tmp', isDefault: true }], activeWorkDirProfileId: 'p1' } as never))
    store.dispatch(setSession('target'))
    const message: Message = { id: 'assistant-origin', sessionId: 'target', role: 'assistant', content: '', timestamp: 1, status: 'streaming', toolCalls: [{ id: 'tool-confirm', toolName: 'run_shell', input: {}, status: 'confirming', riskLevel: 'high' }] }
    store.dispatch(setMessages([message]))
    pendingConfirmStore.reset()
    window.api = { ...window.api,
      sessionGet: vi.fn(async (id: string) => ({ ...session(id), workDirProfileId: 'p1' })),
      chatGetMessages: vi.fn(async () => [message]),
      workdirSwitch: vi.fn(async () => ({ success: true, sessions: [] })),
      configGet: vi.fn(async () => ({ workDir: '/tmp', workDirProfiles: [{ id: 'p1', name: 'tmp', path: '/tmp', isDefault: true }], activeWorkDirProfileId: 'p1' }))
    }
  })

  it('切换到通知所属会话并滚动、聚焦指定确认卡', async () => {
    const { navigateToPendingConfirmation } = await import('./notificationNavigation')
    await navigateToPendingConfirmation({ sessionId: 'target', toolUseId: 'tool-confirm' })

    expect(store.getState().chat.currentSessionId).toBe('target')
    expect(store.getState().chat.scrollToMessageId).toBe('assistant-origin')
    expect(store.getState().chat.confirmFocusToolUseId).toBe('tool-confirm')
  })

  it('切换失败时不移动当前聊天的确认焦点', async () => {
    window.api = { ...window.api, chatGetMessages: vi.fn().mockRejectedValue(new Error('load failed')) }
    const { navigateToPendingConfirmation } = await import('./notificationNavigation')
    await navigateToPendingConfirmation({ sessionId: 'target', toolUseId: 'tool-confirm' })
    expect(store.getState().chat.confirmFocusToolUseId).toBeNull()
  })

  it('旧会话的慢通知响应晚到时不覆盖新会话的滚动与确认焦点', async () => {
    let resolveA!: (rows: Message[]) => void
    const chatGetMessages = vi.fn(({ sessionId }: { sessionId: string }) => sessionId === 'target-a'
      ? new Promise<Message[]>((resolve) => { resolveA = resolve })
      : Promise.resolve([{ id: 'assistant-b', sessionId: 'target-b', role: 'assistant', content: '', timestamp: 2, status: 'streaming', toolCalls: [{ id: 'tool-b', toolName: 'run_shell', input: {}, status: 'confirming', riskLevel: 'high' }] } as Message])
    )
    window.api = { ...window.api,
      sessionGet: vi.fn(async (id: string) => ({ ...session(id), workDirProfileId: 'p1' })),
      chatGetMessages,
      workdirSwitch: vi.fn(async () => ({ success: true, sessions: [] })),
      configGet: vi.fn(async () => ({ workDir: '/tmp', workDirProfiles: [{ id: 'p1', name: 'tmp', path: '/tmp', isDefault: true }], activeWorkDirProfileId: 'p1' }))
    }
    pendingConfirmStore.syncFromProjection({
      sessionId: 'target-a', requestId: 'request-a', turnId: 'turn-a', turnVersion: 1,
      message: { id: 'assistant-a', sessionId: 'target-a', role: 'assistant', content: '', timestamp: 1, status: 'streaming', toolCalls: [{ id: 'tool-a', toolName: 'run_shell', input: {}, status: 'confirming', riskLevel: 'high' }] }
    })
    const pendingA = (await import('./notificationNavigation')).navigateToPendingConfirmation({ sessionId: 'target-a', toolUseId: 'tool-a' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const { navigateToPendingConfirmation } = await import('./notificationNavigation')
    await navigateToPendingConfirmation({ sessionId: 'target-b', toolUseId: 'tool-b' })
    expect(store.getState().chat.currentSessionId).toBe('target-b')
    expect(store.getState().chat.confirmFocusToolUseId).toBe('tool-b')
    expect(store.getState().chat.scrollToMessageId).toBe('assistant-b')

    resolveA([{ id: 'assistant-a', sessionId: 'target-a', role: 'assistant', content: '', timestamp: 1, status: 'streaming', toolCalls: [{ id: 'tool-a', toolName: 'run_shell', input: {}, status: 'confirming', riskLevel: 'high' }] } as Message])
    await pendingA

    expect(store.getState().chat.currentSessionId).toBe('target-b')
    expect(store.getState().chat.confirmFocusToolUseId).toBe('tool-b')
    expect(store.getState().chat.scrollToMessageId).toBe('assistant-b')
  })
})
