import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../electron/database'
import { getDbConnection } from '../electron/database/sqliteStore'
import { drainCanonicalLedgerProjectionOutbox } from '../electron/sessionLedgerOutbox'
import { projectCanonicalSessionLedgerTarget, resolveCanonicalSessionLedgerProjectionTarget } from '../electron/runtime/sessionLedgerOutboxProjector'
import { getSessionEventSink, type SessionEventSink } from '../electron/sessionEvents'

type CountRow = { kind: string; count: number }

function pendingCounts(conn: ReturnType<typeof getDbConnection>): CountRow[] {
  return conn.prepare(`SELECT kind, count(*) AS count FROM (
    SELECT CASE WHEN projection_kind LIKE 'tool-call:%' THEN 'tool-call:*' ELSE projection_kind END AS kind
    FROM session_ledger_projection_outbox WHERE status='pending'
  ) GROUP BY kind ORDER BY kind`).all() as CountRow[]
}

async function main(): Promise<void> {
  const source = process.argv[2]
  if (!source) throw new Error('用法：npx tsx scripts/rehearse-session-ledger-outbox-drain.ts <已关闭的隔离数据库副本>')
  const absoluteSource = path.resolve(source)
  const sourceStatBefore = await fs.stat(absoluteSource)
  const walPath = `${absoluteSource}-wal`
  let sourceWalSizeBefore = 0
  try {
    const wal = await fs.stat(walPath)
    sourceWalSizeBefore = wal.size
    if (wal.size > 0) throw new Error('来源数据库存在非空 WAL；请先生成一致的关闭态隔离副本')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-outbox-rehearsal-'))
  const copyPath = path.join(root, 'isolated-copy.db')
  const sinkRoot = path.join(root, 'projected-sessions')
  const sinks = new Map<string, SessionEventSink>()
  let db: ReturnType<typeof openDatabase> | undefined
  let failed = 0
  let sourceMissing = 0
  let projected = 0
  try {
    await fs.copyFile(absoluteSource, copyPath)
    const sourceStatAfterCopy = await fs.stat(absoluteSource)
    if (sourceStatBefore.size !== sourceStatAfterCopy.size || sourceStatBefore.mtimeMs !== sourceStatAfterCopy.mtimeMs ||
      sourceStatBefore.ctimeMs !== sourceStatAfterCopy.ctimeMs) {
      throw new Error('复制期间来源数据库发生变化；本次演练已取消')
    }

    db = openDatabase(copyPath)
    const conn = getDbConnection(db)
    const createdAtBySession = new Map((conn.prepare('SELECT id,created_at FROM sessions').all() as Array<{ id: string; created_at: number }>).
      map(({ id, created_at }) => [id, created_at]))
    const locationKeys = conn.prepare(`SELECT DISTINCT ledger_location_key FROM session_ledger_projection_outbox
      WHERE status='pending' ORDER BY ledger_location_key`).all() as Array<{ ledger_location_key: string }>
    const before = pendingCounts(conn)

    for (const { ledger_location_key: locationKey } of locationKeys) {
      const result = await drainCanonicalLedgerProjectionOutbox(conn, locationKey, async (target) => {
        const createdAt = createdAtBySession.get(target.sessionId)
        if (createdAt === undefined) throw new Error('outbox target references a missing session')
        const sinkKey = `${target.sessionId}\0${createdAt}`
        let sink = sinks.get(sinkKey)
        if (!sink) {
          sink = getSessionEventSink(sinkRoot, target.sessionId, createdAt)
          sinks.set(sinkKey, sink)
        }
        return projectCanonicalSessionLedgerTarget(sink, target)
      }, Date.now(), (identity) => resolveCanonicalSessionLedgerProjectionTarget(conn, identity))
      projected += result.projected
      sourceMissing += result.sourceMissing?.length ?? 0
      if (result.failedTargetId) failed += 1
    }

    const after = pendingCounts(conn)
    const sourceStatAfterRun = await fs.stat(absoluteSource)
    let sourceWalSizeAfter = 0
    try { sourceWalSizeAfter = (await fs.stat(walPath)).size }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const sourceUnchanged = sourceStatBefore.size === sourceStatAfterRun.size && sourceStatBefore.mtimeMs === sourceStatAfterRun.mtimeMs &&
      sourceStatBefore.ctimeMs === sourceStatAfterRun.ctimeMs && sourceWalSizeBefore === sourceWalSizeAfter
    console.log(JSON.stringify({ source: path.basename(absoluteSource), before, projected, sourceMissing, failed, after,
      isolatedCopyOnly: true, sourceUnchanged }))
    if (!sourceUnchanged || sourceMissing || failed || after.length) process.exitCode = 1
  } finally {
    for (const sink of sinks.values()) await sink.close()
    db?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
