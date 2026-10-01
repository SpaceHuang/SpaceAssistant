import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceAssistantApi } from '../../src/shared/api'

const bridge = vi.hoisted(() => ({ exposedApi: undefined as unknown }))
const invoke = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { bridge.exposedApi = api } },
  ipcRenderer: { invoke }
}))

import '../preload'
import type { Message } from '../../src/shared/domainTypes'

describe('chat:update-queued-message preload contract', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards the payload to the queued edit IPC and returns message plus sequence', async () => {
    const message: Message = { id: 'q1', sessionId: 's1', role: 'user', content: 'edited', timestamp: 1, status: 'queued', schemaVersion: 1 }
    const result = { ok: true as const, message, sequence: 7 }
    invoke.mockResolvedValue(result)
    const api = bridge.exposedApi as SpaceAssistantApi

    await expect(api.chatUpdateQueuedMessage({ sessionId: 's1', messageId: 'q1', content: 'edited' })).resolves.toEqual(result)
    expect(invoke).toHaveBeenCalledWith('chat:update-queued-message', { sessionId: 's1', messageId: 'q1', content: 'edited' })
  })
})

describe('chat:reorder-queued-messages preload contract', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards the ordered message IDs and returns the persisted queue order', async () => {
    const entries = [
      { message: { id: 'q2', sessionId: 's1', role: 'user' as const, content: 'second', timestamp: 2, status: 'queued' as const, schemaVersion: 1 }, sequence: 4 },
      { message: { id: 'q1', sessionId: 's1', role: 'user' as const, content: 'first', timestamp: 1, status: 'queued' as const, schemaVersion: 1 }, sequence: 5 }
    ]
    const result = { ok: true as const, entries }
    invoke.mockResolvedValue(result)
    const api = bridge.exposedApi as SpaceAssistantApi
    await expect(api.chatReorderQueuedMessages({ sessionId: 's1', messageIds: ['q2', 'q1'] })).resolves.toEqual(result)
    expect(invoke).toHaveBeenCalledWith('chat:reorder-queued-messages', { sessionId: 's1', messageIds: ['q2', 'q1'] })
  })
})
