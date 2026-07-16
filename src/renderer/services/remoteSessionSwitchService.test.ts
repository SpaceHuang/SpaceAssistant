import { describe, expect, it, vi, beforeEach } from 'vitest'
import { store } from '../store'
import { setConfig } from '../store/configSlice'
import { setSessions } from '../store/sessionSlice'
import { setSession, setMessages, resetChatUi } from '../store/chatSlice'
import { handleRemoteSessionSwitch } from './remoteSessionSwitchService'
import type { Message, Session } from '../../shared/domainTypes'

const baseConfig = {
  workDir: '/a',
  workDirProfiles: [
    { id: 'p1', name: 'A', path: '/a', isDefault: true },
    { id: 'p2', name: 'B', path: '/b' }
  ],
  activeWorkDirProfileId: 'p1'
}

function makeSession(over: Partial<Session>): Session {
  return {
    id: 's-target',
    name: 'Target',
    preview: '',
    model: 'm',
    temperature: 1,
    maxTokens: 1024,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    schemaVersion: 1,
    ...over
  }
}

function msg(id: string, sessionId: string): Message {
  return {
    id,
    sessionId,
    role: 'user',
    content: id,
    timestamp: 1,
    status: 'sent',
    schemaVersion: 1
  }
}

function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('remoteSessionSwitchService', () => {
  beforeEach(() => {
    store.dispatch(resetChatUi())
    store.dispatch(setSessions([]))
    store.dispatch(setConfig(baseConfig as never))
  })

  it('switches session and loads messages when nothing else races', async () => {
    const previousSessionId = 'previous'
    store.dispatch(setSession(previousSessionId))
    const target = makeSession({ id: 'target', workDirProfileId: 'p1' })
    store.dispatch(setSessions([target]))

    const messages = [msg('m1', 'target')]
    vi.stubGlobal('api', {
      sessionGet: vi.fn(),
      chatGetMessages: vi.fn().mockResolvedValue(messages),
      workdirSwitch: vi.fn(),
      configGet: vi.fn()
    })

    const result = await handleRemoteSessionSwitch('target')

    expect(result).toEqual({ desktopSwitched: true, viewChanged: true })
    expect(store.getState().chat.currentSessionId).toBe('target')
    expect(store.getState().chat.messages).toEqual(messages)
  })

  it('rolls back desktop selection and workDir when message load fails after workDir switch succeeded', async () => {
    const previousSessionId = 'previous'
    store.dispatch(setSession(previousSessionId))
    const target = makeSession({ id: 'target', workDirProfileId: 'p2' })
    store.dispatch(setSessions([target]))

    const workdirSwitch = vi.fn().mockImplementation((profileId: string) => {
      return Promise.resolve({ success: true, sessions: [target] })
    })
    const configGet = vi.fn().mockImplementation(() => {
      const activeWorkDirProfileId = workdirSwitch.mock.calls[workdirSwitch.mock.calls.length - 1]![0]
      return Promise.resolve({ ...baseConfig, activeWorkDirProfileId })
    })

    vi.stubGlobal('api', {
      sessionGet: vi.fn(),
      chatGetMessages: vi.fn().mockRejectedValue(new Error('load failed')),
      workdirSwitch,
      configGet
    })

    const result = await handleRemoteSessionSwitch('target')

    expect(result).toEqual({ desktopSwitched: false, viewChanged: false })
    // Rolled back UI selection to the previous session.
    expect(store.getState().chat.currentSessionId).toBe(previousSessionId)
    // workDir switched forward to p2, then rolled back to the original p1.
    expect(workdirSwitch.mock.calls.map((c) => c[0])).toEqual(['p2', 'p1'])
    expect(store.getState().config.config?.activeWorkDirProfileId).toBe('p1')
  })

  it('does not let a superseded switch overwrite a newer switch state (monotonic token)', async () => {
    const targetA = makeSession({ id: 'targetA', workDirProfileId: 'p1' })
    const targetB = makeSession({ id: 'targetB', workDirProfileId: 'p1' })
    store.dispatch(setSessions([targetA, targetB]))

    let resolveA!: (rows: Message[]) => void
    const chatGetMessages = vi.fn().mockImplementation(({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'targetA') {
        return new Promise<Message[]>((resolve) => {
          resolveA = resolve
        })
      }
      return Promise.resolve([msg('mb', 'targetB')])
    })

    vi.stubGlobal('api', {
      sessionGet: vi.fn(),
      chatGetMessages,
      workdirSwitch: vi.fn(),
      configGet: vi.fn()
    })

    const pendingA = handleRemoteSessionSwitch('targetA')
    // Let the first switch reach its (pending) chatGetMessages call and dispatch setSession.
    await nextMicrotask()
    expect(store.getState().chat.currentSessionId).toBe('targetA')

    const resultB = await handleRemoteSessionSwitch('targetB')
    expect(resultB).toEqual({ desktopSwitched: true, viewChanged: true })
    expect(store.getState().chat.currentSessionId).toBe('targetB')
    const messagesAfterB = store.getState().chat.messages

    resolveA([msg('ma', 'targetA')])
    const resultA = await pendingA

    // Superseded switch must not clobber the newer session's messages/selection.
    expect(store.getState().chat.currentSessionId).toBe('targetB')
    expect(store.getState().chat.messages).toEqual(messagesAfterB)
    expect(resultA.viewChanged).toBe(false)
  })

  it('does not let a slow workDir switch overwrite a newer switch (serialized + compensate)', async () => {
    const targetA = makeSession({ id: 'targetA', workDirProfileId: 'p2' })
    const targetB = makeSession({ id: 'targetB', workDirProfileId: 'p1' })
    store.dispatch(setSessions([targetA, targetB]))
    store.dispatch(setSession('previous'))

    let resolveWorkDirA!: (value: { success: true; sessions: Session[] }) => void
    let activeProfileId = 'p1'
    const workdirSwitch = vi.fn().mockImplementation((profileId: string) => {
      if (profileId === 'p2') {
        return new Promise<{ success: true; sessions: Session[] }>((resolve) => {
          resolveWorkDirA = (value) => {
            activeProfileId = 'p2'
            resolve(value)
          }
        })
      }
      activeProfileId = profileId
      return Promise.resolve({ success: true as const, sessions: [targetB] })
    })
    const configGet = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ...baseConfig,
        activeWorkDirProfileId: activeProfileId
      })
    )

    vi.stubGlobal('api', {
      sessionGet: vi.fn(),
      chatGetMessages: vi.fn().mockImplementation(({ sessionId }: { sessionId: string }) =>
        Promise.resolve([msg(`m-${sessionId}`, sessionId)])
      ),
      workdirSwitch,
      configGet
    })

    const pendingA = handleRemoteSessionSwitch('targetA')
    await nextMicrotask()
    expect(workdirSwitch).toHaveBeenCalledWith('p2')

    // B waits on the workDir queue behind A — do not await yet (would deadlock).
    const pendingB = handleRemoteSessionSwitch('targetB')
    await nextMicrotask()

    resolveWorkDirA({ success: true, sessions: [targetA] })
    const resultA = await pendingA
    const resultB = await pendingB

    expect(resultA).toEqual({ desktopSwitched: false, viewChanged: false })
    expect(resultB).toEqual({ desktopSwitched: true, viewChanged: true })
    expect(store.getState().chat.currentSessionId).toBe('targetB')
    expect(store.getState().chat.messages.map((m) => m.id)).toEqual(['m-targetB'])
    // Final active profile must remain B's p1 — A's late p2 is rolled back before B runs.
    expect(store.getState().config.config?.activeWorkDirProfileId).toBe('p1')
    expect(workdirSwitch.mock.calls.map((c) => c[0])).toEqual(['p2', 'p1'])
  })

  it('does not let a superseded slow switch overwrite a newer profile change', async () => {
    const targetA = makeSession({ id: 'targetA', workDirProfileId: 'p2' })
    const targetB = makeSession({ id: 'targetB', workDirProfileId: 'p3' })
    store.dispatch(
      setConfig({
        ...baseConfig,
        workDirProfiles: [...baseConfig.workDirProfiles, { id: 'p3', name: 'C', path: '/c' }],
        activeWorkDirProfileId: 'p1'
      } as never)
    )
    store.dispatch(setSessions([targetA, targetB]))
    store.dispatch(setSession('previous'))

    let resolveWorkDirA!: (value: { success: true; sessions: Session[] }) => void
    let activeProfileId = 'p1'
    const workdirSwitch = vi.fn().mockImplementation((profileId: string) => {
      if (profileId === 'p2') {
        return new Promise<{ success: true; sessions: Session[] }>((resolve) => {
          resolveWorkDirA = (value) => {
            activeProfileId = 'p2'
            resolve(value)
          }
        })
      }
      activeProfileId = profileId
      return Promise.resolve({
        success: true as const,
        sessions: profileId === 'p3' ? [targetB] : [targetA]
      })
    })
    const configGet = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ...baseConfig,
        workDirProfiles: [...baseConfig.workDirProfiles, { id: 'p3', name: 'C', path: '/c' }],
        activeWorkDirProfileId: activeProfileId
      })
    )

    vi.stubGlobal('api', {
      sessionGet: vi.fn(),
      chatGetMessages: vi.fn().mockImplementation(({ sessionId }: { sessionId: string }) =>
        Promise.resolve([msg(`m-${sessionId}`, sessionId)])
      ),
      workdirSwitch,
      configGet
    })

    const pendingA = handleRemoteSessionSwitch('targetA')
    await nextMicrotask()
    const pendingB = handleRemoteSessionSwitch('targetB')
    await nextMicrotask()

    resolveWorkDirA({ success: true, sessions: [targetA] })
    await pendingA
    await pendingB

    expect(store.getState().chat.currentSessionId).toBe('targetB')
    expect(store.getState().config.config?.activeWorkDirProfileId).toBe('p3')
    // A switched to p2, rolled back to p1 in-queue, then B switched to p3.
    expect(workdirSwitch.mock.calls.map((c) => c[0])).toEqual(['p2', 'p1', 'p3'])
  })
})
