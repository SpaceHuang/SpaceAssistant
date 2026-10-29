import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const proofColumns = [
  'proof_file_identity', 'proof_file_bytes', 'proof_tail_frame', 'proof_index_seq',
  'proof_index_event_count', 'proof_index_bytes', 'proof_index_last_at'
]
const outboxPayloadColumns = ['expected_events_json', 'expected_event_ids_json', 'payload_sha256']
const variants = [
  { variant: 'proof-only', file: 'session-ledger-proof-only.sql', dropped: proofColumns, keepOutboxPayload: true },
  { variant: 'proof-and-outbox-payload', file: 'session-ledger-proof-and-outbox-payload.sql',
    dropped: [...proofColumns, ...outboxPayloadColumns], keepOutboxPayload: false }
] as const

type Snapshot = { size: number; mtimeMs: number; ctimeMs: number }

async function statSnapshot(file: string): Promise<Snapshot> {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('来源必须是普通数据库文件')
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
}

async function assertNoActiveWal(file: string): Promise<void> {
  try {
    const stat = await fs.stat(`${file}-wal`)
    if (stat.size > 0) throw new Error('来源数据库存在非空 WAL；先关闭数据库并生成一致的隔离副本')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(({ name }) => name)
}

function assertColumns(db: DatabaseSync, table: string, expected: readonly string[], present: boolean): void {
  const actual = columns(db, table)
  const matches = expected.every((column) => actual.includes(column) === present)
  if (!matches) throw new Error(`迁移列范围与冻结清单不符：${table}`)
}

function rowCounts(db: DatabaseSync): { readiness: number; outbox: number; pending: number } {
  return {
    readiness: Number((db.prepare('SELECT COUNT(*) AS count FROM session_ledger_projection_state').get() as { count: number }).count),
    outbox: Number((db.prepare('SELECT COUNT(*) AS count FROM session_ledger_projection_outbox').get() as { count: number }).count),
    pending: Number((db.prepare("SELECT COUNT(*) AS count FROM session_ledger_projection_outbox WHERE status='pending'").get() as { count: number }).count)
  }
}

function assertIntegrity(db: DatabaseSync): void {
  const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  if (result.integrity_check !== 'ok') throw new Error(`隔离库 integrity_check 失败：${result.integrity_check}`)
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('隔离库 foreign_key_check 失败')
}

async function rehearseVariant(source: string, root: string, variant: typeof variants[number]) {
  const copy = path.join(root, `${variant.variant}.db`)
  const snapshot = `${copy}.rollback-snapshot`
  await fs.copyFile(source, copy)
  await fs.copyFile(copy, snapshot)
  let db = new DatabaseSync(copy)
  try {
    assertIntegrity(db)
    assertColumns(db, 'session_ledger_projection_state', proofColumns, true)
    assertColumns(db, 'session_ledger_projection_outbox', outboxPayloadColumns, true)
    const stateColumnsBefore = columns(db, 'session_ledger_projection_state')
    const outboxColumnsBefore = columns(db, 'session_ledger_projection_outbox')
    const countsBefore = rowCounts(db)
    const sqlPath = path.resolve('scripts/migrations', variant.file)
    db.exec(await fs.readFile(sqlPath, 'utf8'))
    assertIntegrity(db)
    assertColumns(db, 'session_ledger_projection_state', proofColumns, false)
    assertColumns(db, 'session_ledger_projection_outbox', outboxPayloadColumns, variant.keepOutboxPayload)
    const expectedStateColumns = stateColumnsBefore.filter((column) => !proofColumns.includes(column))
    const expectedOutboxColumns = outboxColumnsBefore.filter((column) =>
      variant.keepOutboxPayload || !outboxPayloadColumns.includes(column))
    if (JSON.stringify(columns(db, 'session_ledger_projection_state')) !== JSON.stringify(expectedStateColumns) ||
      JSON.stringify(columns(db, 'session_ledger_projection_outbox')) !== JSON.stringify(expectedOutboxColumns)) {
      throw new Error('迁移删除或移动了冻结清单以外的列')
    }
    if (JSON.stringify(rowCounts(db)) !== JSON.stringify(countsBefore)) throw new Error('迁移改变了状态行或 outbox 行数量')
    db.close()
    await fs.copyFile(snapshot, copy)
    db = new DatabaseSync(copy)
    assertIntegrity(db)
    assertColumns(db, 'session_ledger_projection_state', proofColumns, true)
    assertColumns(db, 'session_ledger_projection_outbox', outboxPayloadColumns, true)
    if (JSON.stringify(rowCounts(db)) !== JSON.stringify(countsBefore)) throw new Error('快照回退未恢复原行数量')
    return { variant: variant.variant, dropped: [...variant.dropped], rollbackVerified: true }
  } finally {
    db.close()
    await fs.rm(copy, { force: true })
    await fs.rm(snapshot, { force: true })
    for (const suffix of ['-wal', '-shm']) {
      await fs.rm(`${copy}${suffix}`, { force: true })
      await fs.rm(`${snapshot}${suffix}`, { force: true })
    }
  }
}

async function main(): Promise<void> {
  const supplied = process.argv[2]
  if (!supplied) throw new Error('用法：node --import tsx scripts/rehearse-session-ledger-column-migrations.ts <已关闭的隔离数据库副本>')
  const source = path.resolve(supplied)
  const before = await statSnapshot(source)
  await assertNoActiveWal(source)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-column-migration-rehearsal-'))
  try {
    const reports = []
    for (const variant of variants) reports.push(await rehearseVariant(source, root, variant))
    const after = await statSnapshot(source)
    await assertNoActiveWal(source)
    const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after)
    const report = { source: path.basename(source), isolatedCopiesOnly: true, sourceUnchanged, variants: reports }
    console.log(JSON.stringify(report))
    if (!sourceUnchanged) throw new Error('来源数据库在演练期间发生变化')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
