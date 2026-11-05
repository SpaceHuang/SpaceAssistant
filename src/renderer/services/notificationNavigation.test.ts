import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store'
import { setConfig } from '../store/configSlice'
import { setSessions } from '../store/sessionSlice'
import { resetChatUi, setMessages, setSession } from '../store/chatSlice'
import { pendingConfirmStore } from './pendingConfirmStore'
import { handleRemoteSessionSwitch } from './remoteSessionSwitchService'
import { NotificationNavigationStartup } from './notificationNavigationStartup'
import type { Message, Session } from '../../shared/domainTypes'

function session(id: string): Session {
  return { id, name: id, preview: '', model: 'm', temperature: 1, maxTokens: 100, createdAt: 1, updatedAt: 1, messageCount: 1, schemaVersion: 1 }
}

describe('floating confirmation notification navigation', () => {
  let startupNavigation: NotificationNavigationStartup | null = null

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

  afterEach(() => {
    startupNavigation?.dispose()
    startupNavigation = null
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

  it('配置响应延迟时缓冲通知导航，配置就绪后定位并聚焦待确认卡', async () => {
    store.dispatch(setConfig(null))
    store.dispatch(setSession('target-a'))
    const message: Message = {
      id: 'assistant-b', sessionId: 'target-b', role: 'assistant', content: '', timestamp: 2,
      status: 'streaming', toolCalls: [{ id: 'tool-b', toolName: 'run_shell', input: {}, status: 'confirming', riskLevel: 'high' }]
    }
    const chatGetMessages = vi.fn(async () => [message])
    window.api = { ...window.api, chatGetMessages }
    startupNavigation = new NotificationNavigationStartup()

    await startupNavigation.receive({ sessionId: 'target-b', toolUseId: 'tool-b' })
    await startupNavigation.completeInitialSessionLoad([session('target-a'), session('target-b')])

    expect(store.getState().chat.currentSessionId).toBe('target-a')
    expect(chatGetMessages).not.toHaveBeenCalled()
    store.dispatch(setConfig({
      workDir: '/tmp',
      workDirProfiles: [{ id: 'p1', name: 'tmp', path: '/tmp', isDefault: true }],
      activeWorkDirProfileId: 'p1'
    } as never))

    await vi.waitFor(() => {
      expect(store.getState().chat.currentSessionId).toBe('target-b')
      expect(store.getState().chat.confirmFocusToolUseId).toBe('tool-b')
      expect(store.getState().chat.scrollToMessageId).toBe('assistant-b')
    })
    expect(chatGetMessages).toHaveBeenCalledExactlyOnceWith({ sessionId: 'target-b' })
  })

  it('会话列表晚到且通知初始化期间重复到达时，默认会话不会覆盖最新目标', async () => {
    const message: Message = {
      id: 'assistant-b', sessionId: 'target-b', role: 'assistant', content: '', timestamp: 2,
      status: 'streaming', toolCalls: [{ id: 'tool-b', toolName: 'run_shell', input: {}, status: 'confirming', riskLevel: 'high' }]
    }
    const chatGetMessages = vi.fn(async () => [message])
    window.api = { ...window.api, chatGetMessages }
    startupNavigation = new NotificationNavigationStartup()

    await startupNavigation.receive({ sessionId: 'target-a', toolUseId: 'tool-a' })
    await startupNavigation.receive({ sessionId: 'target-b', toolUseId: 'tool-b' })
    expect(store.getState().chat.confirmFocusToolUseId).toBeNull()

    await startupNavigation.completeInitialSessionLoad([
      session('unrelated-first'),
      session('target-a'),
      session('target-b')
    ])

    expect(store.getState().session.list[0].id).toBe('unrelated-first')
    expect(store.getState().chat.currentSessionId).toBe('target-b')
    expect(store.getState().chat.confirmFocusToolUseId).toBe('tool-b')
    expect(store.getState().chat.scrollToMessageId).toBe('assistant-b')
    expect(chatGetMessages).toHaveBeenCalledExactlyOnceWith({ sessionId: 'target-b' })
  })

  it('已 dispose 的旧启动实例收到晚到会话列表时不得覆盖新实例的通知导航', async () => {
    store.dispatch(setConfig({
      workDir: '/tmp',
      workDirProfiles: [{ id: 'p1', name: 'tmp', path: '/tmp', isDefault: true }],
      activeWorkDirProfileId: 'p1'
    } as never))
    const oldStartup = new NotificationNavigationStartup()
    oldStartup.dispose()
    const activeStartup = new NotificationNavigationStartup()
    const targetMessage: Message = {
      id: 'assistant-target', sessionId: 'target-b', role: 'assistant', content: '', timestamp: 2,
      status: 'streaming', toolCalls: [{ id: 'tool-b', toolName: 'run_shell', input: {}, status: 'confirming', riskLevel: 'high' }]
    }
    window.api = { ...window.api, chatGetMessages: vi.fn(async () => [targetMessage]) }

    await activeStartup.receive({ sessionId: 'target-b', toolUseId: 'tool-b' })
    await activeStartup.completeInitialSessionLoad([session('unrelated-first'), session('target-b')])
    await oldStartup.completeInitialSessionLoad([session('unrelated-first'), session('target-b')])

    expect(store.getState().chat.currentSessionId).toBe('target-b')
    expect(store.getState().chat.confirmFocusToolUseId).toBe('tool-b')
    activeStartup.dispose()
  })

  it('dispose 后已启动的旧通知导航不得在异步会话读取完成后提交状态', async () => {
    let resolveMessages!: (rows: Message[]) => void
    window.api = {
      ...window.api,
      chatGetMessages: vi.fn(() => new Promise<Message[]>((resolve) => { resolveMessages = resolve }))
    }
    const oldStartup = new NotificationNavigationStartup()
    await oldStartup.completeInitialSessionLoad([session('target')])
    const navigation = oldStartup.receive({ sessionId: 'target', toolUseId: 'tool-confirm' })
    await vi.waitFor(() => expect(window.api.chatGetMessages).toHaveBeenCalled())

    oldStartup.dispose()
    resolveMessages([{ id: 'late-message', sessionId: 'target', role: 'assistant', content: '', timestamp: 1, status: 'streaming', toolCalls: [] } as Message])
    await navigation

    expect(store.getState().chat.currentSessionId).toBe('target')
    expect(store.getState().chat.confirmFocusToolUseId).toBeNull()
  })

  it('dispose 取消工作区切换时会补偿主进程已完成的切换', async () => {
    const previous = { ...session('previous'), workDirProfileId: 'p1' }
    const target = { ...session('target'), workDirProfileId: 'p2' }
    const config = {
      workDir: '/a',
      workDirProfiles: [
        { id: 'p1', name: 'A', path: '/a', isDefault: true },
        { id: 'p2', name: 'B', path: '/b' }
      ],
      activeWorkDirProfileId: 'p1'
    }
    store.dispatch(setConfig(config as never))
    let hostProfile = 'p1'
    let finishSwitch!: () => void
    const workdirSwitch = vi.fn((profileId: string) => profileId === 'p2'
      ? new Promise<{ success: boolean; sessions: Session[] }>((resolve) => {
          finishSwitch = () => {
            hostProfile = 'p2'
            resolve({ success: true, sessions: [target] })
          }
        })
      : Promise.resolve().then(() => {
          hostProfile = profileId
          return { success: true, sessions: [previous] }
        }))
    window.api = {
      ...window.api,
      workdirSwitch: workdirSwitch as never,
      configGet: vi.fn(async () => ({ ...config, activeWorkDirProfileId: hostProfile })),
      chatGetMessages: vi.fn(async () => [])
    }
    const startup = new NotificationNavigationStartup()
    startupNavigation = startup
    await startup.completeInitialSessionLoad([previous, target])
    const navigation = startup.receive({ sessionId: 'target', toolUseId: 'tool-confirm' })
    await vi.waitFor(() => expect(workdirSwitch).toHaveBeenCalledWith('p2'))

    startup.dispose()
    finishSwitch()
    await navigation

    expect(workdirSwitch.mock.calls.map(([profileId]) => profileId)).toEqual(['p2', 'p1'])
    expect(hostProfile).toBe('p1')
    expect(store.getState().config.config?.activeWorkDirProfileId).toBe('p1')
    expect(store.getState().chat.currentSessionId).toBe('previous')
  })
})
