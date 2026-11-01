import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerService } from './service'
import { createRuntimeTriggerDelivery } from './delivery'
import { createRuntimeTriggerRecovery } from './recovery'
import { evaluateRuntimeTriggerSource } from './sources'
import { SettledStepFactsTracker } from './sources'

describe('runtime trigger capacity and local registration latency', () => {
  it('measures one full History reconstruction and a single appended step update', () => {
    const invocationId = 'history-reconstruction-benchmark'
    const events = Array.from({ length: 5_000 }, (_, index) => ({
      invocationId, turnId: 'turn', sequence: index + 1, schemaVersion: 1,
      eventId: `event-${index + 1}`, idempotencyKey: `key-${index + 1}`, kind: 'model-response-committed' as const,
      payload: { modelTurn: index + 1, message: { role: 'assistant', toolCalls: [] } }
    }))
    const wallStart = new Date().toISOString()
    const initialStart = performance.now()
    const tracker = new SettledStepFactsTracker()
    expect(tracker.update({ invocationId, version: events.length, schemaVersion: 1, events })).toMatchObject({ ok: true, settledCount: 5_000 })
    const reconstructionMs = performance.now() - initialStart
    const appendedEvent = { ...events[0]!, sequence: 5_001, eventId: 'event-5001', idempotencyKey: 'key-5001',
      payload: { modelTurn: 5_001, message: { role: 'assistant', toolCalls: [] } } }
    const appendStart = performance.now()
    expect(tracker.appendEvents({ invocationId, fromVersion: 5_000, version: 5_001, events: [appendedEvent] })).toMatchObject({ ok: true, settledCount: 5_001 })
    const appendOneMs = performance.now() - appendStart
    process.stdout.write(`[runtime-trigger-history] platform=${process.platform} arch=${process.arch} priorEvents=5000 appendedEvents=1 reconstructionMs=${reconstructionMs.toFixed(2)} appendOneMs=${appendOneMs.toFixed(3)} wallStart=${wallStart} wallEnd=${new Date().toISOString()}\n`)
  })

  it('accepts 128 active registrations per owner and rejects the next, with a measured 4096-item app ceiling', async () => {
    const db = createMemoryAppDb()
    try {
      const commands = createSessionCommands(db)
      const owner = createSession(db, { name: 'capacity-owner' }).id
      let now = 1_000_000
      const service = createRuntimeTriggerService(commands, { now: () => now, authorize: () => true, authorizeTarget: () => true,
        maxActivePerOwner: 128, maxActiveGlobal: 4096 })
      const samples: number[] = []
      const registrationWallStart = new Date().toISOString()
      let firstTriggerId = ''
      for (let index = 0; index < 128; index += 1) {
        const started = performance.now()
        const registered = await service.register({ ownerSessionId: owner, params: { clientKey: `owner-${index}`, receiverSessionId: owner,
          expiresAt: now + 60_000, condition: { type: 'time', at: new Date(now + 30_000).toISOString(), taskPrompt: 'capacity' } } })
        if (index === 0) firstTriggerId = registered.trigger.triggerId
        samples.push(performance.now() - started)
      }
      await expect(service.register({ ownerSessionId: owner, params: { clientKey: 'owner-overflow', receiverSessionId: owner,
        expiresAt: now + 60_000, condition: { type: 'time', at: new Date(now + 30_000).toISOString(), taskPrompt: 'capacity' } } }))
        .rejects.toThrow('TRIGGER_CAPACITY:owner-active-limit')
      expect(commands.runtimeTriggers.countActive({ ownerSessionId: owner, now })).toBe(128)
      const first = commands.runtimeTriggers.read(firstTriggerId)!
      const scheduledAt = Date.parse(first.definition.condition.type === 'time' ? first.definition.condition.at : '')
      now = scheduledAt
      service.match({ triggerId: first.id, expectedRevision: first.revision, event: { type: 'time', occurredAt: scheduledAt, taskPrompt: 'capacity' } })
      const matched = commands.runtimeTriggers.read(first.id)!
      const queueScope = { kind: 'desktop' } as const
      const authorization = { bindingVersion: 1 as const, requestId: `runtime-trigger:${first.id}`, ownerSessionId: owner, receiverSessionId: owner,
        queueScope, sourceIdentity: matched.definition.condition, payloadDigest: 'capacity-event', policyRevision: 'policy',
        authorizationGeneration: 'auth', runtimeGeneration: 'runtime' }
      const delivery = createRuntimeTriggerDelivery({ read: (id) => commands.runtimeTriggers.read(id),
        update: (id, revision, patch) => commands.runtimeTriggers.update(id, revision, patch),
        authorize: () => authorization, queueScope: () => queueScope,
        enqueue: (input) => commands.scopedQueue.enqueue(input), readReceipt: (input) => commands.scopedQueue.readReceipt(input) })
      const deliveryWallStart = new Date().toISOString()
      const deliveryStart = performance.now()
      expect(delivery(first.id)).toMatchObject({ kind: 'enqueued' })
      process.stdout.write(`[runtime-trigger-delivery] platform=${process.platform} arch=${process.arch} sourceFacts=1 queueMessages=1 deliveryMs=${(performance.now() - deliveryStart).toFixed(3)} wallStart=${deliveryWallStart} wallEnd=${new Date().toISOString()}\n`)
      const sorted = [...samples].sort((a, b) => a - b)
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!
      const registrationWallEnd = new Date().toISOString()
      expect(Number.isFinite(p95)).toBe(true)
      process.stdout.write(`[runtime-trigger-capacity] platform=${process.platform} arch=${process.arch} n=128 perRegistrationP95Ms=${p95.toFixed(3)} wallStart=${registrationWallStart} wallEnd=${registrationWallEnd}\n`)
      // This local fixture records measurement without making a machine-specific speed promise.
      expect({ machine: process.platform, registrations: samples.length, p95Ms: p95 }).toMatchObject({ machine: process.platform, registrations: 128 })
      now += 120_000
      expect(commands.runtimeTriggers.countActive({ ownerSessionId: owner, now })).toBe(0)
    } finally { db.close() }
  })

  it('enforces the application-wide 4096 ceiling independently from the per-owner limit', async () => {
    const db = createMemoryAppDb()
    try {
      const commands = createSessionCommands(db)
      const service = createRuntimeTriggerService(commands, { authorize: () => true, authorizeTarget: () => true,
        maxActivePerOwner: 4096, maxActiveGlobal: 4096 })
      const owners = Array.from({ length: 33 }, (_, index) => createSession(db, { name: `global-${index}` }).id)
      const started = performance.now()
      const wallStart = new Date().toISOString()
      for (let index = 0; index < 4096; index += 1) {
        const owner = owners[index % owners.length]!
        await service.register({ ownerSessionId: owner, params: { clientKey: `global-${index}`, receiverSessionId: owner,
          expiresAt: Date.now() + 60_000, condition: { type: 'time', at: new Date(Date.now() + 30_000).toISOString(), taskPrompt: 'global-capacity' } } })
      }
      await expect(service.register({ ownerSessionId: owners[0]!, params: { clientKey: 'global-overflow', receiverSessionId: owners[0]!,
        expiresAt: Date.now() + 60_000, condition: { type: 'time', at: new Date(Date.now() + 30_000).toISOString(), taskPrompt: 'global-capacity' } } }))
        .rejects.toThrow('TRIGGER_CAPACITY:application-active-limit')
      expect(commands.runtimeTriggers.countActive({ now: Date.now() })).toBe(4096)
      const registrationMs = performance.now() - started
      const wallEnd = new Date().toISOString()
      process.stdout.write(`[runtime-trigger-capacity] platform=${process.platform} arch=${process.arch} n=4096 registrationMs=${registrationMs.toFixed(1)} monotonicStart=${started.toFixed(3)} monotonicEnd=${(started + registrationMs).toFixed(3)} wallStart=${wallStart} wallEnd=${wallEnd}\n`)
      const waiting = commands.runtimeTriggers.listByState('waiting', 4096)
      const scanRecovery = createRuntimeTriggerRecovery({
        listWaiting: () => waiting, listMatched: () => [], read: (id) => commands.runtimeTriggers.read(id),
        evaluateWaiting: (trigger, now) => evaluateRuntimeTriggerSource(trigger, { now, queries: { imAcceptedFacts: {} } as never }),
        match: () => undefined, expire: () => undefined, fail: () => undefined,
        deliver: () => ({ kind: 'deferred', case: 'not-matched' }), update: () => null,
        readReceipt: () => undefined, isSessionBusy: () => false,
        startReceiver: () => 'unavailable', readTurnTerminal: () => ({ kind: 'missing' })
      })
      const scanStart = performance.now()
      const scanWallStart = new Date().toISOString()
      await scanRecovery.scan()
      const scanMs = performance.now() - scanStart
      process.stdout.write(`[runtime-trigger-capacity] platform=${process.platform} arch=${process.arch} waiting=4096 recoveryScanMs=${scanMs.toFixed(1)} wallStart=${scanWallStart} wallEnd=${new Date().toISOString()}\n`)
    } finally { db.close() }
  }, 60_000)
})
