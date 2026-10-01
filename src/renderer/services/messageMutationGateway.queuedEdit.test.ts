import { beforeEach, describe, expect, it, vi } from 'vitest'
import { store } from '../store'
import { setSession, setMessages, patchDisplayMessage } from '../store/chatSlice'
import { getLiveMessages, resetLiveSessionMessages } from './chatRunnerService'
import { commitQueuedMessageEdit, commitQueuedMessageReorder } from './messageMutationGateway'

const message = { id: 'q1', sessionId: 's1', role: 'user' as const, content: 'before', timestamp: 1, status: 'queued' as const, schemaVersion: 1 }
describe('commitQueuedMessageEdit', () => {
  beforeEach(() => { store.dispatch(setSession('s1')); store.dispatch(setMessages([message])) })
  it('成功后派发正文 patch 并保留当前持久顺序', async () => {
    store.dispatch(patchDisplayMessage({ id: 'q1', patch: {}, order: { kind: 'persisted', sequence: 7 } }))
    Object.assign(window.api, { chatUpdateQueuedMessage: vi.fn().mockResolvedValue({ ok: true, message: { ...message, content: 'after' }, sequence: 42 }) })
    await commitQueuedMessageEdit({ sessionId: 's1', messageId: 'q1', content: 'after' })
    expect(store.getState().chat.messages[0]?.content).toBe('after')
    expect(store.getState().chat.displayEntries[0]?.order).toEqual({ kind: 'persisted', sequence: 7 })
  })
  it('编辑响应迟到时只更新正文，不会把已执行状态改回 queued', async () => {
    let resolveEdit!: (value: { ok: true; message: typeof message; sequence: number }) => void
    Object.assign(window.api, { chatUpdateQueuedMessage: vi.fn(() => new Promise((resolve) => { resolveEdit = resolve })) })
    const pending = commitQueuedMessageEdit({ sessionId: 's1', messageId: 'q1', content: 'after' })
    await vi.waitFor(() => expect(resolveEdit).toBeTypeOf('function'))
    store.dispatch(patchDisplayMessage({ id: 'q1', patch: { status: 'sent' } }))
    resolveEdit({ ok: true, message: { ...message, content: 'after', status: 'queued' }, sequence: 42 })
    await pending
    expect(store.getState().chat.messages[0]?.status).toBe('sent')
    expect(store.getState().chat.displayEntries[0]?.message.status).toBe('sent')
    expect(store.getState().chat.messages[0]?.content).toBe('after')
  })
  it('编辑成功同步 live 快照，后续 API 消息合并不会回退正文', async () => {
    resetLiveSessionMessages('s1', [message])
    Object.assign(window.api, { chatUpdateQueuedMessage: vi.fn().mockResolvedValue({ ok: true, message: { ...message, content: 'after' }, sequence: 42 }) })
    await commitQueuedMessageEdit({ sessionId: 's1', messageId: 'q1', content: 'after' })
    expect(getLiveMessages('s1')?.[0]?.content).toBe('after')
  })
  it('同一消息的多次保存按提交顺序写入并保留最终正文', async () => {
    const pending: Array<(value: { ok: true; message: typeof message; sequence: number }) => void> = []
    Object.assign(window.api, { chatUpdateQueuedMessage: vi.fn(() => new Promise((resolve) => { pending.push(resolve) })) })
    resetLiveSessionMessages('s1', [message])
    const older = commitQueuedMessageEdit({ sessionId: 's1', messageId: 'q1', content: 'older' })
    const newer = commitQueuedMessageEdit({ sessionId: 's1', messageId: 'q1', content: 'newer' })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending).toHaveLength(1)
    pending[0]!({ ok: true, message: { ...message, content: 'older' }, sequence: 42 })
    await older
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!({ ok: true, message: { ...message, content: 'newer' }, sequence: 42 })
    await newer
    expect(store.getState().chat.messages[0]?.content).toBe('newer')
    expect(store.getState().chat.displayEntries[0]?.message.content).toBe('newer')
    expect(getLiveMessages('s1')?.[0]?.content).toBe('newer')
  })
  it('较新保存失败时保留较早已成功写库的正文', async () => {
    let resolveOlder!: (value: { ok: true; message: typeof message; sequence: number }) => void
    const api = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve }))
      .mockRejectedValueOnce(new Error('ipc unavailable'))
    Object.assign(window.api, { chatUpdateQueuedMessage: api })
    resetLiveSessionMessages('s1', [message])
    const older = commitQueuedMessageEdit({ sessionId: 's1', messageId: 'q1', content: 'older saved' })
    const newer = commitQueuedMessageEdit({ sessionId: 's1', messageId: 'q1', content: 'newer failed' })
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    expect(api).toHaveBeenCalledTimes(1)
    resolveOlder({ ok: true, message: { ...message, content: 'older saved' }, sequence: 42 })
    await older
    await expect(newer).rejects.toThrow('ipc unavailable')
    expect(api).toHaveBeenCalledTimes(2)
    expect(store.getState().chat.messages[0]?.content).toBe('older saved')
    expect(store.getState().chat.displayEntries[0]?.message.content).toBe('older saved')
    expect(getLiveMessages('s1')?.[0]?.content).toBe('older saved')
  })
  it('成功重排后更新 Redux 中 queued 消息的持久顺序', async () => {
    const second = { ...message, id: 'q2', content: 'second' }
    store.dispatch(setMessages([message, second]))
    Object.assign(window.api, { chatReorderQueuedMessages: vi.fn().mockResolvedValue({ ok: true, entries: [
      { message: second, sequence: 0 }, { message, sequence: 1 }
    ] }) })
    await commitQueuedMessageReorder({ sessionId: 's1', messageIds: ['q2', 'q1'] })
    expect(store.getState().chat.messages.map((entry) => entry.id)).toEqual(['q2', 'q1'])
    expect(store.getState().chat.displayEntries.map((entry) => entry.message.id)).toEqual(['q2', 'q1'])
  })
  it('连续重排按提交顺序持久化并保留最后一次顺序', async () => {
    const second = { ...message, id: 'q2', content: 'second' }
    store.dispatch(setMessages([message, second]))
    const resolve: Array<(result: { ok: true; entries: Array<{ message: typeof message; sequence: number }> }) => void> = []
    Object.assign(window.api, { chatReorderQueuedMessages: vi.fn(() => new Promise((done) => { resolve.push(done) })) })
    const older = commitQueuedMessageReorder({ sessionId: 's1', messageIds: ['q2', 'q1'] })
    const newer = commitQueuedMessageReorder({ sessionId: 's1', messageIds: ['q1', 'q2'] })
    await vi.waitFor(() => expect(resolve).toHaveLength(1))
    resolve[0]!({ ok: true, entries: [{ message: second, sequence: 0 }, { message, sequence: 1 }] })
    await older
    await vi.waitFor(() => expect(resolve).toHaveLength(2))
    resolve[1]!({ ok: true, entries: [{ message, sequence: 0 }, { message: second, sequence: 1 }] })
    await newer
    expect(store.getState().chat.displayEntries.map((entry) => entry.message.id)).toEqual(['q1', 'q2'])
  })
  it('失败时抛出含 error 码的错误', async () => {
    Object.assign(window.api, { chatUpdateQueuedMessage: vi.fn().mockResolvedValue({ ok: false, error: 'message_not_queued' }) })
    await expect(commitQueuedMessageEdit({ sessionId: 's1', messageId: 'q1', content: 'after' })).rejects.toMatchObject({ code: 'message_not_queued' })
  })
})
