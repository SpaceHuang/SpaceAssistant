import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createSessionCommands } from '../sessionStorage/commands'
import { findRuntimeTriggerByClientKey, insertRuntimeTrigger, readRuntimeTrigger, updateRuntimeTrigger } from './store'

describe('runtime trigger durable store', () => {
  it('round-trips versioned JSON under the owner/client idempotency key and CASes state once', () => {
    const db = createMemoryAppDb()
    try {
      const commands = createSessionCommands(db)
      const record = { id: 'trigger-1', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'client-key',
        definition: { version: 1 as const, condition: { type: 'process_exit' as const, managedProcessId: 'opaque-process' }, sourceBaseline: { runtimeGeneration: 'generation-1' } },
        state: 'waiting' as const, createdAt: 100, expiresAt: 500, attempts: 0, revision: 1, updatedAt: 100 }
      expect(insertRuntimeTrigger(commands, record)).toEqual(record)
      expect(readRuntimeTrigger(commands, record.id)).toEqual(record)
      expect(findRuntimeTriggerByClientKey(commands, 'owner', 'client-key')).toEqual(record)
      const matched = updateRuntimeTrigger(commands, record.id, 1, { state: 'matched', matchedAt: 200, event: { type: 'process_exit', exitCode: 0 }, updatedAt: 200 })
      expect(matched).toMatchObject({ state: 'matched', matchedAt: 200, event: { type: 'process_exit', exitCode: 0 }, revision: 2 })
      expect(updateRuntimeTrigger(commands, record.id, 1, { state: 'cancelled', updatedAt: 300 })).toBeNull()
      expect(getDbConnection(db).prepare('SELECT state,revision FROM runtime_triggers WHERE id=?').get(record.id)).toEqual({ state: 'matched', revision: 2 })
    } finally { db.close() }
  })

  it('rejects corrupt versioned definition JSON instead of guessing a record', () => {
    const db = createMemoryAppDb()
    try {
      const commands = createSessionCommands(db)
      const record = { id: 'trigger-corrupt', ownerSessionId: 'owner', receiverSessionId: 'receiver', clientKey: 'corrupt-key',
        definition: { version: 1 as const, condition: { type: 'process_exit' as const, managedProcessId: 'proc' }, sourceBaseline: {} },
        state: 'waiting' as const, createdAt: 1, expiresAt: 2, attempts: 0, revision: 1, updatedAt: 1 }
      insertRuntimeTrigger(commands, record)
      getDbConnection(db).prepare('UPDATE runtime_triggers SET definition_json=? WHERE id=?').run('{"version":2}', record.id)
      expect(() => readRuntimeTrigger(commands, record.id)).toThrowError(/RUNTIME_TRIGGER_DEFINITION_VERSION_UNSUPPORTED/)
    } finally { db.close() }
  })
})
