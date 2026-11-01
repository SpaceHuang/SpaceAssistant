import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerHostService } from './hostService'

describe('runtime trigger host capability adapter', () => {
  it('filters targets to visible sessions in the owner work profile and owned processes', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner', workDirProfileId: 'profile-a' })
      const peer = createSession(db, { name: 'peer', workDirProfileId: 'profile-a' })
      createSession(db, { name: 'other profile', workDirProfileId: 'profile-b' })
      const hidden = createSession(db, { name: 'hidden', workDirProfileId: 'profile-a', ownership: 'internal', visibility: 'hidden' })
      const listProcesses = vi.fn((sessionId: string) => sessionId === owner.id ? [{ kind: 'managed-process' as const, id: 'proc-owned', label: 'run_shell' }] : [])
      const queries = { listSessions: () => [owner, peer], imAcceptedFacts: {} }
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db), queries: queries as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }) } as never,
        listProcesses, processGeneration: () => 'generation-1' })
      expect(service.targets({ ownerSessionId: owner.id, params: {} }).items.map(({ id }) => id)).toEqual([owner.id, peer.id, 'proc-owned'])
      await expect(service.register({ ownerSessionId: owner.id, params: { clientKey: 'hidden-target', receiverSessionId: hidden.id,
        expiresAt: Date.now() + 10_000, condition: { type: 'time', at: new Date(Date.now() + 1_000).toISOString(), taskPrompt: 'wake' } } }))
        .rejects.toMatchObject({ failure: { code: 'TRIGGER_NOT_FOUND_OR_FORBIDDEN' } })
    } finally { db.close() }
  })

  it('binds IM source registration to the owner conversation and existing accepted account facts', async () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'remote owner', workDirProfileId: 'profile-a', metadata: { source: 'wechat', wechatMeta: { userId: 'alice' } } })
      let through = 0
      const queries = { listSessions: () => [owner], imAcceptedFacts: { captureFrontier: ({ accountId, conversationId }: { accountId: string; conversationId: string }) => ({
        through: accountId === 'account-a' && conversationId === 'alice' ? through : 0, coverageRevision: 1
      }) } }
      const service = createRuntimeTriggerHostService({ commands: createSessionCommands(db), queries: queries as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }) } as never })
      const params = { clientKey: 'im-trigger', receiverSessionId: owner.id, expiresAt: Date.now() + 60_000,
        condition: { type: 'im_message', channel: 'wechat', accountId: 'account-a', conversationId: 'alice' } }
      await expect(service.register({ ownerSessionId: owner.id, params })).rejects.toMatchObject({ failure: { code: 'TRIGGER_NOT_FOUND_OR_FORBIDDEN' } })
      through = 1
      await expect(service.register({ ownerSessionId: owner.id, params })).resolves.toMatchObject({ trigger: { state: 'waiting', definition: { sourceBaseline: { through: 1, coverageRevision: 1 } } } })
    } finally { db.close() }
  })
})
