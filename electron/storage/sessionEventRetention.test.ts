import fs from 'fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentLoggerModule from '../agentLogger/agentLogger'
import { appendCompactionTransaction, readCompactionReplay, SessionEventWriter } from '../sessionEvents'
import { computeCompactionSummaryHash } from '../../src/shared/compactionEvents'
import { createMemoryAppDb } from '../database/testHelpers'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { appendMessage, setConfigValue } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { rebuildClaudeMessagesFromHistory } from '../runtime/canonicalHistory'
import * as transcriptProjection from '../sessionStorage/infrastructure/sqlite/sessionTranscriptProjection'
import type { Message } from '../../src/shared/domainTypes'
import {
  createSessionLedgerCompactionDependencyGuard,
  createCanonicalSessionProjectionRetentionPreparer
} from '../sessionStorage/infrastructure/sqlite/sessionEventRetentionAdapter'
import { enforceSessionEventRetention, enforceSessionEventRetentionDetailed, runSessionEventRetentionMaintenance } from './sessionEventRetention'

/**
 * S3(偏差 24):会话事件台账保留期从 sessionEvents.ts(Core 文件)归位 Storage——
 * 本文件自 sessionEvents.test.ts 搬入,消费口改 electron/storage/sessionEventRetention,
 * 并新增「删除留痕」验收(删了什么、多少个、依据哪条策略)。
 */

let warnSpy: ReturnType<typeof vi.spyOn>

function createRetentionPreparedStorage(db: ReturnType<typeof createMemoryAppDb>) {
  const history = new SqliteAgentHistory(getDbConnection(db))
  return {
    ensureChatBodyV1: async ({ sessionId }: { sessionId: string }) => ({ sessionId }),
    queries: {
      readMessages: () => [] as Message[],
      readPreparedMessages: async ({ sessionId }: { sessionId: string }) => {
        const result = history.readCanonicalSessionTranscriptForShadow(sessionId)
        return result.kind === 'matched' ? result.messages as Message[] : []
      }
    }
  } as never
}

beforeEach(() => {
  warnSpy = vi.spyOn(agentLoggerModule, 'logAgentEvent').mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('sessionEventRetention(归位 Storage,偏差 24)', () => {
  it('requires the prepared SessionStorage reader instead of falling back to a synchronous transcript read', async () => {
    const db = createMemoryAppDb()
    const projectionRead = vi.spyOn(transcriptProjection, 'getProjectedMessages')
    try {
      expect(() => createCanonicalSessionProjectionRetentionPreparer(db, undefined as never))
        .toThrow('SESSION_RETENTION_PREPARED_READER_REQUIRED')
      expect(projectionRead).not.toHaveBeenCalled()
    } finally {
      projectionRead.mockRestore()
      db.close()
    }
  })

  it('prepares chatBodyV1 before selecting projected messages for retention', async () => {
    const db = createMemoryAppDb()
    getDbConnection(db).prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('retention-order','s','m',0.7,1,1,1,'{}','{}',1,'retention-order-generation')`).run()
    const order: string[] = []
    const projectionRead = vi.spyOn(transcriptProjection, 'getProjectedMessages').mockImplementation(() => {
      order.push('read-projected-messages')
      return []
    })
    try {
      const prepare = createCanonicalSessionProjectionRetentionPreparer(db, {
        ensureChatBodyV1: async ({ sessionId }) => { order.push(`ensure:${sessionId}`); return { sessionId } },
        queries: {
          readMessages: () => { order.push('read-legacy-messages'); return [] },
          readPreparedMessages: async () => { order.push('read-prepared-messages'); return [] }
        }
      } as never)
      await prepare('retention-order-19700101', '/work')
      expect(order).toEqual(['ensure:retention-order', 'read-prepared-messages'])
      expect(projectionRead).not.toHaveBeenCalled()
    } finally {
      projectionRead.mockRestore()
      db.close()
    }
  })

  it('retains the newest event sessions by index timestamp', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-'))
    for (const [id, time] of [['old', 1], ['new', 2]] as const) {
      const writer = new SessionEventWriter(root, id, time)
      await writer.append({ type: 'session_end_seed', payload: { seedSeq: 0 } })
      await fs.writeFile(writer.indexPath, JSON.stringify({ seq: 1, lastAt: time, eventCount: 1, bytes: 1 }))
    }
    expect(await enforceSessionEventRetention(root, 1)).toBe(1)
    expect(await fs.stat(path.join(root, 'sessions', 'new-19700101'))).toBeTruthy()
    await expect(fs.stat(path.join(root, 'sessions', 'old-19700101'))).rejects.toThrow()
  })

  it('isolates retention deletion failure and continues the retention pass', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-failure-'))
    for (const [id, time] of [['oldest', 1], ['middle', 2], ['newest', 3]] as const) {
      const dir = path.join(root, 'sessions', `${id}-19700101`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
    }
    const originalRm = fs.rm
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === path.join(root, 'sessions', 'oldest-19700101')) throw new Error('retention delete failed')
      return originalRm(target, options)
    })

    const result = await enforceSessionEventRetentionDetailed(root, 1)
    expect(result.removed).toBe(1)
    expect(result.failures).toMatchObject([{ sessionName: 'oldest-19700101', phase: 'retention-delete' }])
    await expect(fs.stat(path.join(root, 'sessions', 'middle-19700101'))).rejects.toThrow()
    expect(await fs.stat(path.join(root, 'sessions', 'newest-19700101'))).toBeTruthy()
    rmSpy.mockRestore()
  })

  it('propagates session-directory scan failures so the watermark is not advanced', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-scan-failure-'))
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const readdir = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(failure)
    await expect(enforceSessionEventRetentionDetailed(root, 1)).rejects.toMatchObject({ code: 'EACCES' })
    readdir.mockRestore()
  })

  it('continues processing other workspace roots after one root scan fails', async () => {
    const db = createMemoryAppDb()
    const failedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-root-failed-'))
    const healthyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-root-healthy-'))
    setConfigValue(db, 'retention.sessionEvent.maxSessions', '1')
    for (const [name, lastAt] of [['old-19700101', 1], ['new-19700101', 2]] as const) {
      const sessionDir = path.join(healthyRoot, 'sessions', name)
      await fs.mkdir(sessionDir, { recursive: true })
      await fs.writeFile(path.join(sessionDir, 'events.index.json'), JSON.stringify({ lastAt }))
    }
    const originalReaddir = fs.readdir
    const failedPath = path.join(failedRoot, 'sessions')
    const readdir = vi.spyOn(fs, 'readdir').mockImplementation((target, options) => {
      if (target === failedPath) return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })) as never
      return originalReaddir(target as string, options as never) as never
    })
    const result = await runSessionEventRetentionMaintenance(db, [failedRoot, healthyRoot])
    readdir.mockRestore()
    expect(result.summary.failures).toMatchObject([{ sessionName: failedRoot, phase: 'retention-delete' }])
    await expect(fs.stat(path.join(healthyRoot, 'sessions', 'old-19700101'))).rejects.toThrow()
    expect(await fs.stat(path.join(healthyRoot, 'sessions', 'new-19700101'))).toBeTruthy()
    db.close()
  })

  it('删除留痕:removed > 0 时落 retention.sessionEvents.cleaned(策略 + 名单 + 数量)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-audit-'))
    for (const [id, time] of [['old', 1], ['new', 2]] as const) {
      const dir = path.join(root, 'sessions', `${id}-19700101`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
    }
    warnSpy.mockClear()
    await enforceSessionEventRetentionDetailed(root, 1)
    expect(warnSpy).toHaveBeenCalledWith(
      'info',
      'retention.sessionEvents.cleaned',
      expect.objectContaining({
        strategy: 'maxSessions',
        maxSessions: 1,
        removed: 1,
        removedSessions: ['old-19700101']
      })
    )
  })

  it('无删除不落清理审计', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-clean-'))
    warnSpy.mockClear()
    await enforceSessionEventRetentionDetailed(root, 3)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('locks only selected deletion candidates through readiness, dependency recheck and delete', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-lifecycle-lock-'))
    for (const [name, lastAt] of [['old-19700101', 1], ['new-19700101', 2]] as const) {
      const dir = path.join(root, 'sessions', name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt }))
    }
    let locked = false
    const order: string[] = []
    const result = await enforceSessionEventRetentionDetailed(root, 1, {
      withSessionLifecycleLock: async (_name, _workDir, operation) => {
        locked = true
        order.push('lock')
        try { return await operation() } finally { locked = false }
      },
      ensureReadyBeforeDelete: async () => { expect(locked).toBe(true); order.push('ready'); return true },
      shouldRetainSessionDir: async () => { expect(locked).toBe(true); order.push('dependency'); return false },
      verifyReadyBeforeDelete: async () => { expect(locked).toBe(true); order.push('final-check'); return true }
    })
    expect(order).toEqual(['lock', 'ready', 'dependency', 'final-check'])
    expect(result.removed).toBe(1)
    await expect(fs.stat(path.join(root, 'sessions', 'old-19700101'))).rejects.toThrow()
    expect(await fs.stat(path.join(root, 'sessions', 'new-19700101'))).toBeTruthy()
  })

  it('fails closed when a canonical compaction dependency has an unknown owner and corrupt payload', async () => {
    const db = createMemoryAppDb()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-corrupt-history-'))
    const conn = getDbConnection(db)
    conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(?,1,1,NULL)')
      .run('unknown-owner-compaction')
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at,session_id)
      VALUES(?,1,?,?,?,?,?,?,?,NULL)`).run('unknown-owner-compaction', 'corrupt-compaction', 'corrupt-key', 'corrupt-turn', 1,
      'transcript-compacted', '{', 1)
    try {
      const dependencyGuard = createSessionLedgerCompactionDependencyGuard(db)
      await expect(dependencyGuard('unknown-owner-19700101', root)).rejects.toThrow('canonical compaction History is corrupt')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      db.close()
    }
  })

  it('retains a blocked candidate without invoking dependency deletion checks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-blocked-ledger-'))
    for (const [name, lastAt] of [['old-19700101', 1], ['new-19700101', 2]] as const) {
      const dir = path.join(root, 'sessions', name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt }))
    }
    const dependency = vi.fn(async () => false)
    const result = await enforceSessionEventRetentionDetailed(root, 1, {
      withSessionLifecycleLock: async (_name, _workDir, operation) => operation(),
      ensureReadyBeforeDelete: async () => false,
      shouldRetainSessionDir: dependency
    })
    expect(result).toMatchObject({ removed: 0, retained: [{ sessionName: 'old-19700101' }] })
    expect(dependency).not.toHaveBeenCalled()
    expect(await fs.stat(path.join(root, 'sessions', 'old-19700101'))).toBeTruthy()
  })

  it('enforces the retention limit for every profile root and preserves canonical compaction dependencies', async () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'retention.sessionEvent.maxSessions', '1')
    const roots = [
      await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-profile-a-')),
      await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-profile-b-'))
    ]
    for (const [rootIndex, root] of roots.entries()) {
      for (const [id, time] of [['old', 1], ['new', 2]] as const) {
        const dir = path.join(root, 'sessions', `${rootIndex}-${id}-19700101`)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
      }
    }
    const conn = getDbConnection(db)
    const insertStream = conn.prepare('INSERT INTO agent_history_streams(invocation_id, version, schema_version, session_id) VALUES(?, 1, 1, ?)')
    const insertEvent = conn.prepare(`INSERT INTO agent_history_events(invocation_id, sequence, event_id, idempotency_key, turn_id, schema_version, kind, payload_json, created_at)
      VALUES(?, 1, ?, ?, ?, 1, 'transcript-compacted', ?, 1)`)
    insertStream.run('canonical-compaction', '0-old')
    insertEvent.run('canonical-compaction', 'compact', 'compact-key', 'turn', JSON.stringify({ sessionLedger: { location: { sessionId: '0-old', workDir: roots[0], createdAt: 1 } } }))
    const ledgerOnly = new SessionEventWriter(roots[1]!, '1-old', 1)
    await appendCompactionTransaction(ledgerOnly,
      { compactionId: 'ledger-only-compaction', inputSurfaceFingerprint: 'input', targetTokens: 1 },
      { compactionId: 'ledger-only-compaction', summaryHash: computeCompactionSummaryHash({}), outputSurfaceFingerprint: 'output', candidate: {} })
    await ledgerOnly.close()
    await fs.writeFile(path.join(roots[1]!, 'sessions', '1-old-19700101', 'events.index.json'), JSON.stringify({ lastAt: 1 }))
    const dependencyGuard = createSessionLedgerCompactionDependencyGuard(db)
    await expect(dependencyGuard('0-old-19700101', roots[0]!)).resolves.toBe(true)
    await expect(dependencyGuard('1-old-19700101', roots[1]!)).resolves.toBe(true)
    const result = await runSessionEventRetentionMaintenance(db, roots, {
      shouldRetainSessionDir: dependencyGuard
    })

    expect(result.summary.removed).toBe(0)
    expect(result.summary.retained.map(({ sessionName }) => sessionName)).toEqual(['0-old-19700101', '1-old-19700101'])
    expect(warnSpy).toHaveBeenCalledWith('info', 'retention.sessionEvents.cleaned', expect.objectContaining({
      removed: 0, retainedDueToDependencies: ['0-old-19700101']
    }))
    for (const root of roots) {
      await expect(fs.stat(path.join(root, 'sessions', `${roots.indexOf(root)}-old-19700101`))).resolves.toBeTruthy()
      await expect(fs.stat(path.join(root, 'sessions', `${roots.indexOf(root)}-new-19700101`))).resolves.toBeTruthy()
    }
    const replay = await readCompactionReplay(path.join(roots[1]!, 'sessions', '1-old-19700101', 'events.jsonl'))
    expect(replay.committed.map(({ compactionId }) => compactionId)).toEqual(['ledger-only-compaction'])
    db.close()
  })

  it('keeps canonical transcript folding identical after retention deletes an ordinary ledger', async () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'retention.sessionEvent.maxSessions', '1')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-canonical-fold-'))
    const oldLedger = new SessionEventWriter(root, 'ordinary-session', 1)
    await oldLedger.appendCritical({ type: 'turn_start', payload: { turnId: 'ordinary-turn' } })
    await oldLedger.appendCritical({ type: 'assistant_chunk', payload: { turnId: 'ordinary-turn', delta: { type: 'text_delta', text: 'ledger-only chunk' } } })
    await oldLedger.close()
    await fs.writeFile(oldLedger.indexPath, JSON.stringify({ lastAt: 1 }))
    const recentLedger = new SessionEventWriter(root, 'recent-session', 2)
    await recentLedger.appendCritical({ type: 'session_end_seed', payload: { seedSeq: 0 } })
    await recentLedger.close()
    await fs.writeFile(recentLedger.indexPath, JSON.stringify({ lastAt: 2 }))

    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, 'ordinary-session')
    await history.appendBatch([{
      invocationId: 'ordinary-invocation', turnId: 'ordinary-turn', sequence: 1, schemaVersion: 1,
      eventId: 'ordinary-context', idempotencyKey: 'ordinary-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'user', id: 'ordinary-user', content: 'keep this question', timestamp: 1 },
        { role: 'assistant', id: 'ordinary-assistant', content: 'canonical answer', timestamp: 2 }
      ] }
    }], 0)
    const fold = async () => rebuildClaudeMessagesFromHistory((await history.read('ordinary-invocation')).events)
    const beforeRetention = await fold()

    const result = await runSessionEventRetentionMaintenance(db, [root], {
      shouldRetainSessionDir: createSessionLedgerCompactionDependencyGuard(db)
    })

    expect(result.summary.removed).toBe(1)
    await expect(fs.stat(oldLedger.eventsPath)).rejects.toThrow()
    expect(await fold()).toEqual(beforeRetention)
    expect(beforeRetention).toEqual([
      { role: 'user', content: 'keep this question', id: 'ordinary-user', timestamp: 1 },
      { role: 'assistant', content: 'canonical answer', id: 'ordinary-assistant', timestamp: 2 }
    ])
    db.close()
  })

  it('fails closed and records a retention guard error without deleting the candidate', async () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'retention.sessionEvent.maxSessions', '1')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-guard-failure-'))
    for (const [id, time] of [['old', 1], ['new', 2]] as const) {
      const dir = path.join(root, 'sessions', `${id}-19700101`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
    }
    const result = await runSessionEventRetentionMaintenance(db, [root], {
      shouldRetainSessionDir: async (name) => {
        if (name === 'old-19700101') throw new Error('dependency lookup failed')
        return false
      }
    })

    expect(result.summary.removed).toBe(0)
    expect(result.summary.failures).toMatchObject([{ sessionName: 'old-19700101', phase: 'retention-delete' }])
    await expect(fs.stat(path.join(root, 'sessions', 'old-19700101'))).resolves.toBeTruthy()
    db.close()
  })

  it('deletes a legacy ledger only after its replacement projection is durable', async () => {
    const persistent = createTempDatabase('session-retention-projection-restart-')
    let db = persistent.db
    setConfigValue(db, 'retention.sessionEvent.maxSessions', '1')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-projection-boundary-'))
    for (const [id, time] of [['old', 1], ['new', 2]] as const) {
      const dir = path.join(root, 'sessions', `${id}-19700101`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
    }
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('old','s','m',0.7,1,1,1,'{}','{}',1,'retention-generation')`).run()
    let history = new SqliteAgentHistory(conn, 1, () => 100, 'old')
    const messages = [{ role: 'user', content: 'durable question', id: 'retention-user', timestamp: 1 }]
    appendMessage(db, { ...messages[0]!, sessionId: 'old', status: 'completed' })
    await history.appendBatch([{
      invocationId: 'retention-invocation', turnId: 'retention-turn', sequence: 1, schemaVersion: 1,
      eventId: 'retention-context', idempotencyKey: 'retention-context', kind: 'invocation-context-committed', payload: { messages }
    }], 0)
    conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id='old'").run()
    conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE id='retention-user'").run()
    let prepareProjection = createCanonicalSessionProjectionRetentionPreparer(db, createRetentionPreparedStorage(db))
    let simulateCrashAfterProjectionCommit = true
    const interrupted = await runSessionEventRetentionMaintenance(db, [root], {
      prepareProjectionForRetention: async (sessionName, workDir) => {
        await prepareProjection(sessionName, workDir)
        if (simulateCrashAfterProjectionCommit) {
          simulateCrashAfterProjectionCommit = false
          throw new Error('simulated crash after projection commit')
        }
      }
    })
    expect(interrupted.summary.removed).toBe(0)
    expect(interrupted.summary.failures).toMatchObject([{ sessionName: 'old-19700101', phase: 'retention-delete' }])
    await expect(fs.stat(path.join(root, 'sessions', 'old-19700101'))).resolves.toBeTruthy()
    expect(conn.prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id='old' AND cache_key='transcript'").get())
      .toBeUndefined()

    db.close()
    db = openDatabase(persistent.dbPath)
    history = new SqliteAgentHistory(getDbConnection(db), 1, () => 101, 'old')
    prepareProjection = createCanonicalSessionProjectionRetentionPreparer(db, createRetentionPreparedStorage(db))

    const result = await runSessionEventRetentionMaintenance(db, [root], { prepareProjectionForRetention: prepareProjection })

    expect(result.summary.removed).toBe(1)
    await expect(fs.stat(path.join(root, 'sessions', 'old-19700101'))).rejects.toThrow()
    expect(history.readCanonicalSessionTranscriptForShadow('old')).toMatchObject({ kind: 'matched', messages })
    expect(getDbConnection(db).prepare("SELECT 1 FROM canonical_session_projection_cache WHERE session_id='old' AND cache_key='transcript'").get())
      .toBeUndefined()
    db.close()
    persistent.cleanup()
  })

  it('fails closed when replacement projection cannot be committed', async () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'retention.sessionEvent.maxSessions', '1')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-projection-failure-'))
    for (const [id, time] of [['old', 1], ['new', 2]] as const) {
      const dir = path.join(root, 'sessions', `${id}-19700101`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
    }
    const result = await runSessionEventRetentionMaintenance(db, [root], {
      prepareProjectionForRetention: async () => { throw new Error('projection commit failed') }
    })

    expect(result.summary.removed).toBe(0)
    expect(result.summary.failures).toMatchObject([{ sessionName: 'old-19700101', phase: 'retention-delete' }])
    await expect(fs.stat(path.join(root, 'sessions', 'old-19700101'))).resolves.toBeTruthy()
    db.close()
  })
})
