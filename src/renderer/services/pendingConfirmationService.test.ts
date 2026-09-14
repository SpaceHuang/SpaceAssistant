import { describe, expect, it, vi } from 'vitest'
import { PendingConfirmationService } from './pendingConfirmationService'

const key = { sessionId: 's1', turnId: 't1', requestId: 'r1', turnVersion: 2, toolCallId: 'tool-1' }
const snapshot = { ...key, confirmation: { complete: true as const } }

describe('PendingConfirmationService', () => {
  it('同一 key single-flight，并在成功后进入 ready', async () => {
    let resolve!: (value: typeof snapshot) => void
    const get = vi.fn(() => new Promise<typeof snapshot>((r) => { resolve = r }))
    const service = new PendingConfirmationService(get)
    const first = service.load(key)
    const second = service.load(key)
    expect(first).toBe(second)
    expect(service.getState().status).toBe('loading')
    resolve(snapshot)
    await first
    expect(service.getState()).toEqual({ status: 'ready', snapshot })
  })

  it('旧响应不得复活已替换的确认，读取失败不可批准', async () => {
    let resolve!: (value: typeof snapshot) => void
    const get = vi.fn(() => new Promise<typeof snapshot>((r) => { resolve = r }))
    const service = new PendingConfirmationService(get)
    const first = service.load(key)
    service.clear({ ...key, turnVersion: 3 })
    resolve(snapshot)
    await first
    expect(service.getState().status).toBe('absent')
  })
})
