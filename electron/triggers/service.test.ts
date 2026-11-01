import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerService } from './service'

describe('runtime trigger registration service', () => {
  it('is idempotent by owner/clientKey and hides foreign records', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const other = createSession(db, { name: 'other' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      let timestamp = 10_000
      let baselineGeneration = 0
      const service = createRuntimeTriggerService(createSessionCommands(db), { now: () => timestamp, authorize: () => true, authorizeTarget: () => true,
        resolveBaseline: () => ({ baselineGeneration: ++baselineGeneration }) })
      const params = { clientKey: 'stable-key', receiverSessionId: receiver, expiresAt: 20_000,
        condition: { type: 'turn_completed', targetSessionId: owner, turnId: 'turn-1' } }
      const created = service.register({ ownerSessionId: owner, params })
      expect(service.register({ ownerSessionId: owner, params })).toEqual({ ...created, replayed: true })
      expect(() => service.register({ ownerSessionId: owner, params: { ...params, receiverSessionId: other } })).toThrow('TRIGGER_CONFLICT:client-key-definition-mismatch')
      expect(() => service.get({ ownerSessionId: other, triggerId: created.trigger.triggerId })).toThrow('TRIGGER_NOT_FOUND_OR_FORBIDDEN')
      timestamp = 30_000
      expect(service.register({ ownerSessionId: owner, params })).toEqual({ ...created, replayed: true })
    } finally { db.close() }
  })

  it('rejects invalid lifetime, capacity, synchronous self-wait, and a second active sync target', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      const commands = createSessionCommands(db)
      const service = createRuntimeTriggerService(commands, { now: () => 10_000, maxActivePerOwner: 1, authorize: () => true, authorizeTarget: () => true })
      const sync = { type: 'session_steps', targetSessionId: owner, origin: 'registration', threshold: 1, mode: 'sync', pauseTimeoutMs: 1000, onPauseTimeout: 'fail' }
      expect(() => service.register({ ownerSessionId: owner, params: { clientKey: 'self', receiverSessionId: owner, expiresAt: 20_000, condition: sync } })).toThrow('TRIGGER_CONFLICT:sync-self-wait')
      const params = { clientKey: 'sync-1', receiverSessionId: receiver, expiresAt: 20_000, condition: sync }
      service.register({ ownerSessionId: owner, params })
      expect(() => service.register({ ownerSessionId: owner, params: { ...params, clientKey: 'sync-2' } })).toThrow('TRIGGER_CONFLICT:sync-target-already-registered')
      expect(() => service.register({ ownerSessionId: owner, params: { clientKey: 'over-capacity', receiverSessionId: receiver, expiresAt: 20_000,
        condition: { type: 'process_exit', managedProcessId: 'proc' } } })).toThrow('TRIGGER_CAPACITY:owner-active-limit')
      expect(() => service.register({ ownerSessionId: owner, params: { ...params, clientKey: 'expired', expiresAt: 9_999 } })).toThrow('TRIGGER_INVALID:expiry-out-of-range')
    } finally { db.close() }
  })

  it('uses revision CAS for cancel versus match and never resurrects a terminal record', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      const service = createRuntimeTriggerService(createSessionCommands(db), { now: () => 10_000, authorize: () => true, authorizeTarget: () => true })
      const created = service.register({ ownerSessionId: owner, params: { clientKey: 'race', receiverSessionId: receiver, expiresAt: 20_000,
        condition: { type: 'process_exit', managedProcessId: 'proc' } } })
      const cancelled = service.cancel({ ownerSessionId: owner, params: { triggerId: created.trigger.triggerId, expectedRevision: 1 } })
      expect(cancelled.trigger.state).toBe('cancelled')
      expect(service.match({ triggerId: created.trigger.triggerId, expectedRevision: 1, event: { type: 'process_exit' } })).toBeNull()
      expect(() => service.cancel({ ownerSessionId: owner, params: { triggerId: created.trigger.triggerId, expectedRevision: cancelled.trigger.revision } })).toThrow('TRIGGER_CONFLICT:terminal-state')
    } finally { db.close() }
  })

  it('filters target pages by authorization and only cancels an accepted matched sync wait', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      let cancelledWaits = 0
      const service = createRuntimeTriggerService(createSessionCommands(db), { now: () => 10_000, authorize: () => true,
        authorizeTarget: ({ target }) => target.id !== 'hidden',
        listTargets: () => [{ kind: 'session', id: 'visible-a', label: 'A' }, { kind: 'session', id: 'hidden', label: 'Hidden' }, { kind: 'managed-process', id: 'visible-b', label: 'B' }],
        cancelSyncWait: () => { cancelledWaits += 1 } })
      const targets = service.targets({ ownerSessionId: owner, params: { limit: 1 } })
      expect(targets.items.map((target) => target.id)).toEqual(['visible-a'])
      expect(service.targets({ ownerSessionId: owner, params: { cursor: targets.nextCursor, limit: 10 } }).items.map((target) => target.id)).toEqual(['visible-b'])
      const created = service.register({ ownerSessionId: owner, params: { clientKey: 'sync', receiverSessionId: receiver, expiresAt: 20_000,
        condition: { type: 'session_steps', targetSessionId: owner, origin: 'registration', threshold: 1, mode: 'sync', pauseTimeoutMs: 1000, onPauseTimeout: 'fail' } } })
      service.match({ triggerId: created.trigger.triggerId, expectedRevision: 1, event: { checkpointKey: 'step-1' } })
      expect(() => service.cancel({ ownerSessionId: owner, params: { triggerId: created.trigger.triggerId, expectedRevision: 1 } })).toThrow('revision-changed')
      expect(cancelledWaits).toBe(0)
      service.cancel({ ownerSessionId: owner, params: { triggerId: created.trigger.triggerId, expectedRevision: 2 } })
      expect(cancelledWaits).toBe(1)
    } finally { db.close() }
  })

  it('allows async same-session registration and exposes stable terminal failures by owner query', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const service = createRuntimeTriggerService(createSessionCommands(db), { now: () => 10_000, authorize: () => true, authorizeTarget: () => true })
      const created = service.register({ ownerSessionId: owner, params: { clientKey: 'async-self', receiverSessionId: owner, expiresAt: 20_000,
        condition: { type: 'session_steps', targetSessionId: owner, origin: 'registration', threshold: 3, mode: 'async' } } })
      const failed = service.fail({ triggerId: created.trigger.triggerId, expectedRevision: 1, code: 'TRIGGER_SOURCE_GAP', caseId: 'history-gap' })
      expect(failed.trigger.state).toBe('failed')
      expect(service.get({ ownerSessionId: owner, triggerId: created.trigger.triggerId }).trigger.failure).toEqual({ code: 'TRIGGER_SOURCE_GAP', case: 'history-gap' })
      expect(service.list({ ownerSessionId: owner, params: { limit: 10 } }).items).toHaveLength(1)
    } finally { db.close() }
  })

  it('keeps terminal states immutable across a deterministic mixed operation sequence', () => {
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'owner' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      const service = createRuntimeTriggerService(createSessionCommands(db), { now: () => 10_000, authorize: () => true, authorizeTarget: () => true })
      let seed = 0x7a11
      const random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed }
      for (let index = 0; index < 24; index += 1) {
        const registered = service.register({ ownerSessionId: owner, params: { clientKey: `random-${index}`, receiverSessionId: receiver,
          expiresAt: 20_000, condition: { type: 'process_exit', managedProcessId: `process-${index}` } } })
        const triggerId = registered.trigger.triggerId
        if (random() % 3 === 0) service.match({ triggerId, expectedRevision: 1, event: { kind: 'exit' } })
        const afterMatch = service.get({ ownerSessionId: owner, triggerId }).trigger
        if (afterMatch.state === 'waiting' && random() % 2 === 0) service.cancel({ ownerSessionId: owner, params: { triggerId, expectedRevision: afterMatch.revision } })
        else if (afterMatch.state === 'matched' || afterMatch.state === 'waiting') service.fail({ triggerId, expectedRevision: afterMatch.revision, code: 'TRIGGER_HANDLING_FAILED', caseId: 'random-settle' })
        const terminal = service.get({ ownerSessionId: owner, triggerId }).trigger
        expect(['completed', 'cancelled', 'expired', 'failed']).toContain(terminal.state)
        const revision = terminal.revision
        expect(service.match({ triggerId, expectedRevision: revision, event: { kind: 'late' } })).toBeNull()
        expect(service.get({ ownerSessionId: owner, triggerId }).trigger).toEqual(terminal)
      }
    } finally { db.close() }
  })

  it('uses the global active limit separately and expires due registrations with CAS', () => {
    const db = createMemoryAppDb()
    try {
      const ownerA = createSession(db, { name: 'owner-a' }).id
      const ownerB = createSession(db, { name: 'owner-b' }).id
      const receiver = createSession(db, { name: 'receiver' }).id
      let timestamp = 10_000
      const service = createRuntimeTriggerService(createSessionCommands(db), { now: () => timestamp, maxActiveGlobal: 1, authorize: () => true, authorizeTarget: () => true })
      const first = service.register({ ownerSessionId: ownerA, params: { clientKey: 'global-a', receiverSessionId: receiver, expiresAt: 20_000,
        condition: { type: 'process_exit', managedProcessId: 'a' } } })
      expect(() => service.register({ ownerSessionId: ownerB, params: { clientKey: 'global-b', receiverSessionId: receiver, expiresAt: 20_000,
        condition: { type: 'process_exit', managedProcessId: 'b' } } })).toThrow('TRIGGER_CAPACITY:application-active-limit')
      timestamp = 20_000
      service.expire({ triggerId: first.trigger.triggerId, expectedRevision: 1 })
      expect(service.get({ ownerSessionId: ownerA, triggerId: first.trigger.triggerId }).trigger.state).toBe('expired')
      expect(service.register({ ownerSessionId: ownerB, params: { clientKey: 'global-b', receiverSessionId: receiver, expiresAt: 30_000,
        condition: { type: 'process_exit', managedProcessId: 'b' } } }).trigger.state).toBe('waiting')
    } finally { db.close() }
  })
})
