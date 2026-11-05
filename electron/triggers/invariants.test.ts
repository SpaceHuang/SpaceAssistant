import { describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { createSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerService } from './service'

describe('runtime trigger durable invariants under deterministic operation sequences', () => {
  it('replays seed 0x51a7 and preserves single-winner, terminal-state and bounded-capacity invariants after every operation', async () => {
    const seed = 0x51a7
    let randomState = seed
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState }
    const temp = createTempDatabase('runtime-trigger-seeded-invariants-')
    let db = temp.db
    try {
      const owner = createSession(db, { name: 'random-invariant' }).id
      let commands = createSessionCommands(db)
      let now = 10_000
      const makeService = () => createRuntimeTriggerService(commands, { now: () => now, maxActivePerOwner: 32, maxActiveGlobal: 64,
        authorize: () => true, authorizeTarget: () => true })
      let service = makeService()
      const ids: string[] = []
      const exercised = new Set<string>()
      const requiredPrefix = [0, 1, 3, 0, 2, 0, 3, 0, 4, 5] as const
      for (let step = 0; step < 300; step += 1) {
        const operation = requiredPrefix[step] ?? random() % 6
        if (operation === 0 && ids.length < 30) {
          const clientKey = `seed-${seed}-step-${step}`
          const registered = await service.register({ ownerSessionId: owner, params: { clientKey, receiverSessionId: owner,
            expiresAt: now + 20_000, condition: { type: 'time', at: new Date(now + 1_000).toISOString(), taskPrompt: 'wake' } } })
          ids.push(registered.trigger.triggerId)
          exercised.add('register')
        } else if (ids.length) {
          const id = ids[step < requiredPrefix.length ? ids.length - 1 : random() % ids.length]!
          const record = commands.runtimeTriggers.read(id)
          if (operation === 5) {
            db.close()
            db = openDatabase(temp.dbPath)
            commands = createSessionCommands(db)
            service = makeService()
            exercised.add('restart')
          } else if (record?.state === 'waiting' || record?.state === 'matched') {
            if (operation === 1 && record.state === 'waiting') {
              now += 1_000
              if (service.match({ triggerId: id, expectedRevision: record.revision, event: { type: 'time', occurredAt: now } })) exercised.add('match')
            }
            else if (operation === 2) {
              try { service.cancel({ ownerSessionId: owner, params: { triggerId: id, expectedRevision: record.revision } }); exercised.add('cancel') } catch { /* CAS lost is an expected race outcome. */ }
            } else if (operation === 3) {
              service.fail({ triggerId: id, expectedRevision: record.revision,
                code: record.state === 'matched' ? 'TRIGGER_DELIVERY_FAILED' : 'TRIGGER_SOURCE_GAP',
                caseId: record.state === 'matched' ? 'dispatch-fail' : 'seeded-gap' })
              exercised.add(record.state === 'matched' ? 'dispatch-fail' : 'source-gap')
            }
            else if (operation === 4) { now += 25_000; try { service.expire({ triggerId: id, expectedRevision: record.revision }); exercised.add('expire') } catch { /* Expiry is conditional on durable deadline. */ } }
          }
        }
        const rows = ids.map((id) => commands.runtimeTriggers.read(id)).filter((row) => row !== null)
        const matched = rows.filter((row) => row.state === 'matched')
        expect(matched.length, `seed=${seed} step=${step}`).toBeLessThanOrEqual(ids.length)
        expect(new Set(rows.map((row) => row.clientKey)).size, `seed=${seed} step=${step}`).toBe(rows.length)
        expect(commands.runtimeTriggers.countActive({ ownerSessionId: owner, now })).toBeLessThanOrEqual(32)
        for (const row of rows) {
          if (row.state !== 'waiting' && row.state !== 'matched') {
            expect(commands.runtimeTriggers.update(row.id, row.revision, { state: 'matched', event: { type: 'late' }, updatedAt: now }),
              `seed=${seed} step=${step} trigger=${row.id}`).toBeNull()
          }
          if (row.state === 'matched') expect(row.event).toBeDefined()
        }
      }
      expect([...exercised].sort()).toEqual(['cancel', 'dispatch-fail', 'expire', 'match', 'register', 'restart', 'source-gap'])
    } finally { temp.cleanup(db) }
  })
})
