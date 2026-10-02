import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { runPeriodicSqliteMaintenance, schedulePeriodicSqliteMaintenance } from './periodicSqliteMaintenance'

describe('periodic SQLite maintenance', () => {
  afterEach(() => vi.useRealTimers())

  it('optimizes and truncates the WAL while idle, but skips while a turn fence is active', () => {
    const temp = createTempDatabase('periodic-sqlite-maintenance-')
    const conn = getDbConnection(temp.db)
    expect(runPeriodicSqliteMaintenance(temp.db)).toBe('checkpointed')
    conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES('s','t','o',1,'executing',1,1)`).run()
    expect(runPeriodicSqliteMaintenance(temp.db)).toBe('busy')
    temp.cleanup()
  })

  it('runs on the requested cadence and can be stopped', () => {
    vi.useFakeTimers()
    const temp = createTempDatabase('periodic-sqlite-schedule-')
    const onResult = vi.fn()
    const stop = schedulePeriodicSqliteMaintenance(temp.db, { intervalMs: 50, onResult })
    vi.advanceTimersByTime(100)
    expect(onResult).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(100)
    expect(onResult).toHaveBeenCalledTimes(2)
    temp.cleanup()
  })
})
