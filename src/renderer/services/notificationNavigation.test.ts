import { beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store'
import { setConfig } from '../store/configSlice'
import { setSessions } from '../store/sessionSlice'
import { resetChatUi, setMessages, setSession } from '../store/chatSlice'
import { pendingConfirmStore } from './pendingConfirmStore'
import { handleRemoteSessionSwitch } from './remoteSessionSwitchService'
import type { Message, Session } from '../../shared/domainTypes'

vi.mock('./remoteSessionSwitchService', () => ({ handleRemoteSessionSwitch: vi.fn() }))

function session(id: string): Session {
  return { id, name: id, preview: '', model: 'm', temperature: 1, maxTokens: 100, createdAt: 1, updatedAt: 1, messageCount: 1, schemaVersion: 1 }
}

describe('floating confirmation notification navigation', () => {
  beforeEach(() => {
    store.dispatch(resetChatUi())
    store.dispatch(setSessions([session('target')]))
    store.dispatch(setConfig({ workDir: '/tmp', workDirProfiles: [], activeWorkDirProfileId: '' } as never))
    store.dispatch(setSession('target'))
    const message: Message = { id: 'assistant-origin', sessionId: 'target', role: 'assistant', content: '', timestamp: 1, status: 'streaming', toolCalls: [{ id: 'tool-confirm', toolName: 'run_shell', input: {}, status: 'confirming', riskLevel: 'high' }] }
    store.dispatch(setMessages([message]))
    pendingConfirmStore.reset()
    vi.mocked(handleRemoteSessionSwitch).mockResolvedValue({ desktopSwitched: true, viewChanged: true })
  })

  it('切换到通知所属会话并滚动、聚焦指定确认卡', async () => {
    const { navigateToPendingConfirmation } = await import('./notificationNavigation')
    await navigateToPendingConfirmation({ sessionId: 'target', toolUseId: 'tool-confirm' })

    expect(handleRemoteSessionSwitch).toHaveBeenCalledWith('target')
    expect(store.getState().chat.scrollToMessageId).toBe('assistant-origin')
    expect(store.getState().chat.confirmFocusToolUseId).toBe('tool-confirm')
  })

  it('切换失败时不移动当前聊天的确认焦点', async () => {
    vi.mocked(handleRemoteSessionSwitch).mockResolvedValue({ desktopSwitched: false, viewChanged: false })
    const { navigateToPendingConfirmation } = await import('./notificationNavigation')
    await navigateToPendingConfirmation({ sessionId: 'target', toolUseId: 'tool-confirm' })
    expect(store.getState().chat.confirmFocusToolUseId).toBeNull()
  })
})
