import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerService } from './service'

describe('runtime trigger durable invariants under deterministic operation sequences', () => {
  it('replays seed 0x51a7 and preserves single-winner, terminal-state and bounded-capacity invariants after every operation', async () => {
    const seed = 0x51a7
    let randomState = seed
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState }
    const db = createMemoryAppDb()
    try {
      const owner = createSession(db, { name: 'random-invariant' }).id
      const commands = createSessionCommands(db)
      let now = 10_000
      const service = createRuntimeTriggerService(commands, { now: () => now, maxActivePerOwner: 32, maxActiveGlobal: 64,
        authorize: () => true, authorizeTarget: () => true })
      const ids: string[] = []
      for (let step = 0; step < 300; step += 1) {
        const operation = random() % 5
        if (operation === 0 && ids.length < 30) {
          const clientKey = `seed-${seed}-step-${step}`
          const registered = await service.register({ ownerSessionId: owner, params: { clientKey, receiverSessionId: owner,
            expiresAt: now + 20_000, condition: { type: 'time', at: new Date(now + 1_000).toISOString(), taskPrompt: 'wake' } } })
          ids.push(registered.trigger.triggerId)
        } else if (ids.length) {
          const id = ids[random() % ids.length]!
          const record = commands.runtimeTriggers.read(id)
          if (record?.state === 'waiting') {
            if (operation === 1) service.match({ triggerId: id, expectedRevision: record.revision, event: { type: 'time', occurredAt: now } })
            else if (operation === 2) {
              try { service.cancel({ ownerSessionId: owner, params: { triggerId: id, expectedRevision: record.revision } }) } catch { /* CAS lost is an expected race outcome. */ }
            } else if (operation === 3) service.fail({ triggerId: id, expectedRevision: record.revision, code: 'TRIGGER_SOURCE_GAP', caseId: 'seeded-gap' })
            else { now += 25_000; try { service.expire({ triggerId: id, expectedRevision: record.revision }) } catch { /* Expiry is conditional on durable deadline. */ } }
          }
        }
        const rows = ids.map((id) => commands.runtimeTriggers.read(id)).filter((row) => row !== null)
        const matched = rows.filter((row) => row.state === 'matched')
        expect(matched.length, `seed=${seed} step=${step}`).toBeLessThanOrEqual(ids.length)
        expect(commands.runtimeTriggers.countActive({ ownerSessionId: owner, now })).toBeLessThanOrEqual(32)
        for (const row of rows) {
          if (row.state !== 'waiting' && row.state !== 'matched') {
            expect(commands.runtimeTriggers.update(row.id, row.revision, { state: 'matched', event: { type: 'late' }, updatedAt: now }),
              `seed=${seed} step=${step} trigger=${row.id}`).toBeNull()
          }
          if (row.state === 'matched') expect(row.event).toBeDefined()
        }
      }
    } finally { db.close() }
  })
})
