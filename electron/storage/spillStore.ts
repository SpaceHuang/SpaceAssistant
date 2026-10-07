import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { lock as acquireFileLock } from 'proper-lockfile'
import type { DatabaseSync } from 'node:sqlite'
import { logAgentEvent } from '../agentLogger/agentLogger'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { resolveRetentionPolicyFromDb } from './retentionPolicy'
import { collectSpillDescriptorsStrict, SpillContentUnavailableError, readSourceTruthSpillSync, type SpillDescriptor } from './spillProtocol'

export { SpillContentUnavailableError } from './spillProtocol'
export type { SpillDescriptor } from './spillProtocol'

export type SpillStore = ReturnType<typeof createSpillStore>

export class SpillRootFenceBusyError extends Error {
  readonly code = 'SPILL_ROOT_FENCE_BUSY'
  constructor(options?: ErrorOptions) {
    super('spill root fence is currently held', options)
    this.name = 'SpillRootFenceBusyError'
  }
}

/** Uses the durable SQLite file's userData directory; in-memory test/temporary adapters remain spill-disabled. */
export function createSpillStoreForDatabase(conn: DatabaseSync): SpillStore | undefined {
  try {
    if (!conn || typeof conn.prepare !== 'function') return undefined
    const main = conn.prepare('PRAGMA database_list').all().find((entry) => (entry as { name?: string }).name === 'main') as { file?: string } | undefined
    if (!main?.file) return undefined
    return createSpillStore(path.join(path.dirname(main.file), 'spill'))
  } catch {
    return undefined
  }
}

const DEGRADED_PLACEHOLDER = '[内容已归档]'
const EDGE_SAMPLE_CHARS = 256

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function assertSafeLocator(root: string, descriptor: SpillDescriptor): string {
  if (!/^[0-9a-f-]+\.spill$/.test(descriptor.locator) || path.basename(descriptor.locator) !== descriptor.locator) {
    throw new Error('spill locator is invalid')
  }
  return path.join(root, descriptor.locator)
}

export function createSpillStore(root: string) {
  const withSpillRootFence = async <T>(work: () => Promise<T>, waitForLock = true): Promise<T> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    let release: () => Promise<void>
    try {
      release = await acquireFileLock(root, {
        realpath: false, stale: 30_000, update: 10_000,
        retries: waitForLock ? { retries: 12, minTimeout: 5, maxTimeout: 80, factor: 1.5 } : 0
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ELOCKED') throw new SpillRootFenceBusyError({ cause: error })
      throw error
    }
    try { return await work() } finally { await release() }
  }

  const writeObject = async (kind: SpillDescriptor['kind'], payload: string): Promise<SpillDescriptor> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    await fs.chmod(root, 0o700)
    const bytes = Buffer.from(payload, 'utf8')
    const locator = `${randomUUID()}.spill`
    const absolutePath = path.join(root, locator)
    let file: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      file = await fs.open(absolutePath, 'wx', 0o600)
      await file.writeFile(bytes)
      await file.sync()
      await file.close()
      file = undefined
      const directory = await fs.open(root, 'r')
      try { await directory.sync() } finally { await directory.close() }
      const persisted = await fs.readFile(absolutePath)
      if (persisted.byteLength !== bytes.byteLength || sha256(persisted) !== sha256(bytes)) {
        throw new Error('spill verification failed')
      }
      return {
        version: 1,
        kind,
        locator,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        createdAt: Date.now(),
        head: payload.slice(0, EDGE_SAMPLE_CHARS),
        tail: payload.slice(-EDGE_SAMPLE_CHARS)
      }
    } finally {
      await file?.close().catch(() => undefined)
    }
  }

  const readVerified = async (descriptor: SpillDescriptor): Promise<string> => {
    try {
      const content = await fs.readFile(assertSafeLocator(root, descriptor))
      if (content.byteLength !== descriptor.byteLength || sha256(content) !== descriptor.sha256) {
        throw new Error('spill byte length or checksum mismatch')
      }
      return content.toString('utf8')
    } catch (cause) {
      throw new SpillContentUnavailableError(`spill content unavailable: ${descriptor.locator}`, { cause })
    }
  }

  const reconcileOrphansUnderFence = async (input: { referencedLocators: ReadonlySet<string>; fullReferenceScanComplete: boolean }): Promise<string[]> => {
    if (!input.fullReferenceScanComplete) throw new Error('spill orphan reconciliation requires a full reference scan')
    const names = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    const removed: string[] = []
    for (const name of names) {
      if (!/^[0-9a-f-]+\.spill$/.test(name) || input.referencedLocators.has(name)) continue
      const filePath = path.join(root, name)
      const stat = await fs.lstat(filePath)
      if (stat.isSymbolicLink() || !stat.isFile()) continue
      await fs.unlink(filePath)
      removed.push(name)
    }
    if (removed.length > 0) await syncDirectory(root)
    return removed
  }
  const pruneDegradableUnderFence = async (descriptors: readonly SpillDescriptor[], options: { retentionDays: number; now?: number }): Promise<string[]> => {
    if (descriptors.some(({ kind }) => kind !== 'degradable')) throw new Error('source-of-truth spill cannot be pruned')
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) throw new Error('spill retentionDays must be positive')
    const cutoff = (options.now ?? Date.now()) - options.retentionDays * 24 * 60 * 60 * 1000
    const expired = descriptors.filter(({ createdAt }) => createdAt < cutoff)
    const removed: string[] = []
    for (const descriptor of expired) {
      await fs.rm(assertSafeLocator(root, descriptor), { force: true })
      removed.push(descriptor.locator)
    }
    if (removed.length > 0) logAgentEvent('info', 'retention.spill.cleaned', { kind: 'degradable', retentionDays: options.retentionDays, removed })
    return removed
  }

  return {
    root,
    withSpillRootFence,
    async commitSourceTruth(payload: string, commitCanonicalLocator: (descriptor: SpillDescriptor) => void | Promise<void>): Promise<SpillDescriptor> {
      if (!payload.length) throw new Error('source-of-truth spill payload must not be empty')
      return withSpillRootFence(async () => {
        return commitSourceTruthUnderFence(payload, commitCanonicalLocator)
      })
    },
    async commitSourceTruthUnderFence(payload: string, commitCanonicalLocator: (descriptor: SpillDescriptor) => void | Promise<void> = () => undefined): Promise<SpillDescriptor> {
      if (!payload.length) throw new Error('source-of-truth spill payload must not be empty')
      return commitSourceTruthUnderFence(payload, commitCanonicalLocator)
    },

    async readSourceTruth(descriptor: SpillDescriptor): Promise<string> {
      if (descriptor.kind !== 'source-of-truth') throw new Error('expected source-of-truth spill')
      return readVerified(descriptor)
    },

    readSourceTruthSync(descriptor: SpillDescriptor): string {
      return readSourceTruthSpillSync(root, descriptor)
    },

    async writeDegradable(payload: string, facts: { canonicalEquivalent: boolean }): Promise<SpillDescriptor> {
      if (!facts.canonicalEquivalent) throw new Error('degradable spill must be reconstructible from canonical history')
      return withSpillRootFence(() => writeObject('degradable', payload))
    },

    async readDegradable(descriptor: SpillDescriptor): Promise<string> {
      if (descriptor.kind !== 'degradable') throw new Error('expected degradable spill')
      try { return await readVerified(descriptor) } catch { return DEGRADED_PLACEHOLDER }
    },

    async pruneDegradable(descriptors: readonly SpillDescriptor[], options: { retentionDays: number; now?: number }): Promise<string[]> {
      return withSpillRootFence(() => pruneDegradableUnderFence(descriptors, options))
    },
    async pruneDegradableUnderFence(descriptors: readonly SpillDescriptor[], options: { retentionDays: number; now?: number }): Promise<string[]> {
      return pruneDegradableUnderFence(descriptors, options)
    },

    async reconcileOrphans(input: { referencedLocators: ReadonlySet<string>; fullReferenceScanComplete: boolean }): Promise<string[]> {
      if (!input.fullReferenceScanComplete) throw new Error('spill orphan reconciliation requires a full reference scan')
      return withSpillRootFence(() => reconcileOrphansUnderFence(input))
    },
    reconcileOrphansUnderFence
  }

  async function commitSourceTruthUnderFence(payload: string, commitCanonicalLocator: (descriptor: SpillDescriptor) => void | Promise<void>): Promise<SpillDescriptor> {
    const descriptor = await writeObject('source-of-truth', payload)
    // Keep the durable file if the DB transaction fails: its commit result may be uncertain,
    // and a full-reference-scan orphan pass can safely reclaim it later.
    await commitCanonicalLocator(descriptor)
    return descriptor
  }
}

async function syncDirectory(root: string): Promise<void> {
  const directory = await fs.open(root, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export type SpillReferenceScanStats = Readonly<{
  eventHistoryRows: number
  transcriptRows: number
  payloadBytes: number
  descriptorCount: number
  uniqueLocatorCount: number
  eventHistoryDurationMs: number
  transcriptDurationMs: number
  durationMs: number
}>

/** Scan every canonical History payload before orphan deletion; malformed rows fail closed. */
export function readCanonicalSpillReferences(conn: DatabaseSync, options: { allowMissingTables?: boolean } = {}): { descriptors: SpillDescriptor[]; referencedLocators: Set<string>; stats: SpillReferenceScanStats } {
  const startedAt = performance.now()
  const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name))
  if (!options.allowMissingTables && (!tables.has('agent_history_events') || !tables.has('session_transcript_entries'))) {
    throw new Error('canonical spill reference tables are unavailable')
  }
  const descriptors: SpillDescriptor[] = []
  let payloadBytes = 0
  let eventHistoryRows = 0
  let transcriptRows = 0
  let eventHistoryDurationMs = 0
  let transcriptDurationMs = 0
  const scanTable = (table: 'agent_history_events' | 'session_transcript_entries', column: 'payload_json' | 'messages_json'): number => {
    const started = performance.now()
    const rows = conn.prepare(`SELECT ${column} AS value FROM ${table}`).iterate() as Iterable<{ value: string }>
    for (const row of rows) {
      payloadBytes += Buffer.byteLength(row.value, 'utf8')
      collectSpillDescriptorsStrict(JSON.parse(row.value) as unknown, descriptors)
      if (table === 'agent_history_events') eventHistoryRows += 1
      else transcriptRows += 1
    }
    return performance.now() - started
  }
  if (tables.has('agent_history_events')) eventHistoryDurationMs = scanTable('agent_history_events', 'payload_json')
  if (tables.has('session_transcript_entries')) transcriptDurationMs = scanTable('session_transcript_entries', 'messages_json')
  const referencedLocators = new Set(descriptors.map(({ locator }) => locator))
  return {
    descriptors,
    referencedLocators,
    stats: {
      eventHistoryRows,
      transcriptRows,
      payloadBytes,
      descriptorCount: descriptors.length,
      uniqueLocatorCount: referencedLocators.size,
      eventHistoryDurationMs,
      transcriptDurationMs,
      durationMs: performance.now() - startedAt
    }
  }
}

export async function reconcileSpillOrphansAgainstCanonicalHistory(store: SpillStore, conn: DatabaseSync): Promise<string[]> {
  return store.withSpillRootFence(async () => {
    const references = readCanonicalSpillReferences(conn)
    return store.reconcileOrphansUnderFence({ referencedLocators: references.referencedLocators, fullReferenceScanComplete: true })
  }, false)
}

export type SourceTruthSpillGcSummary = Readonly<{ pending: number; completed: number; shared: number; failed: number; classified: number; scanStatus: 'pending' | 'complete' }>

/** Process durable session-delete obligations only after a full, strict all-session reference scan. */
export async function runSourceTruthSpillGcMaintenance(
  db: AppDatabase,
  root: string,
  now = Date.now(),
  options: { batchSize?: number; fullScanIntervalMs?: number } = {}
): Promise<SourceTruthSpillGcSummary> {
  const conn = getDbConnection(db)
  const store = createSpillStore(root)
  const batchSize = Math.max(1, Math.min(10_000, Math.floor(options.batchSize ?? 250)))
  const fullScanIntervalMs = options.fullScanIntervalMs ?? 7 * 24 * 60 * 60 * 1000
  try { return await store.withSpillRootFence(async () => {
    const scanState = conn.prepare(`SELECT status,after_name,completed_at FROM source_truth_spill_gc_scan_state
      WHERE root_key='user-data-spill'`).get() as { status: 'pending' | 'complete'; after_name: string | null; completed_at: number | null } | undefined
    if (!scanState) throw new Error('source-truth spill scan state is missing')
    const startScan = scanState.status === 'complete' && scanState.completed_at !== null && scanState.completed_at <= now - fullScanIntervalMs
    const pendingBeforeScan = Number((conn.prepare("SELECT COUNT(*) AS count FROM source_truth_spill_gc_queue WHERE status='pending'").get() as { count: number }).count)
    if (scanState.status === 'complete' && !startScan && pendingBeforeScan === 0) {
      return { pending: 0, completed: 0, shared: 0, failed: 0, classified: 0, scanStatus: 'complete' }
    }
    if (startScan) conn.prepare(`UPDATE source_truth_spill_gc_scan_state SET status='pending',after_name=NULL,started_at=?,completed_at=NULL,
      last_error=NULL,updated_at=? WHERE root_key='user-data-spill'`).run(now, now)
    let references: ReturnType<typeof readCanonicalSpillReferences>
    try {
      references = readCanonicalSpillReferences(conn)
    } catch (error) {
      const pending = conn.prepare(`SELECT locator FROM source_truth_spill_gc_queue WHERE status='pending'`).all() as Array<{ locator: string }>
      const markFailed = conn.prepare(`UPDATE source_truth_spill_gc_queue
        SET attempts=attempts+1,last_error=?,updated_at=? WHERE locator=? AND status='pending'`)
      for (const item of pending) markFailed.run('canonical-reference-scan-failed', now, item.locator)
      conn.prepare(`UPDATE source_truth_spill_gc_scan_state SET attempts=attempts+1,last_error='canonical-reference-scan-failed',updated_at=?
        WHERE root_key='user-data-spill'`).run(now)
      logAgentEvent('warn', 'storage.spill.source_truth_gc_failed', {
        phase: 'reference-scan', pending: pending.length,
        reason: error instanceof Error ? error.name : 'unknown'
      })
      return { pending: pending.length, completed: 0, shared: 0, failed: pending.length, classified: 0, scanStatus: 'pending' }
    }

    const shouldClassifyDirectory = scanState.status === 'pending' || startScan
    let classified = 0
    let scanStatus: 'pending' | 'complete' = scanState.status
    if (shouldClassifyDirectory) {
      const priorCursor = startScan ? null : scanState.after_name
      const names = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
      const candidates = names.filter((name) => priorCursor === null || name > priorCursor).sort().slice(0, batchSize + 1)
      const page = candidates.slice(0, batchSize)
      const enqueueDiscovered = conn.prepare(`INSERT OR IGNORE INTO source_truth_spill_gc_queue(
        locator,session_id,generation,status,attempts,last_error,created_at,updated_at
      ) VALUES(?, '', '', 'pending', 0, NULL, ?, ?)`)
      for (const name of page) {
        if (!/^[0-9a-f-]+\.spill$/.test(name) || references.referencedLocators.has(name)) continue
        const filePath = path.join(root, name)
        let stat: Awaited<ReturnType<typeof fs.lstat>>
        try { stat = await fs.lstat(filePath) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        if (stat.isSymbolicLink() || !stat.isFile()) continue
        enqueueDiscovered.run(name, now, now)
        classified += 1
      }
      scanStatus = candidates.length <= batchSize ? 'complete' : 'pending'
      if (scanStatus === 'complete') {
        conn.prepare(`UPDATE source_truth_spill_gc_scan_state SET status='complete',after_name=NULL,completed_at=?,started_at=COALESCE(started_at,?),
          attempts=attempts+1,last_error=NULL,updated_at=? WHERE root_key='user-data-spill'`).run(now, now, now)
      } else {
        conn.prepare(`UPDATE source_truth_spill_gc_scan_state SET status='pending',after_name=?,started_at=COALESCE(started_at,?),
          last_error=NULL,updated_at=? WHERE root_key='user-data-spill'`).run(page[page.length - 1] ?? null, now, now)
      }
    }

    const pending = conn.prepare(`SELECT locator,session_id,generation FROM source_truth_spill_gc_queue
      WHERE status='pending' ORDER BY created_at,locator`).all() as Array<{ locator: string; session_id: string; generation: string }>

    let completed = 0
    let shared = 0
    let failed = 0
    const markCompleted = conn.prepare(`UPDATE source_truth_spill_gc_queue SET status='completed',attempts=attempts+1,
      last_error=NULL,updated_at=? WHERE locator=? AND status='pending'`)
    const markPendingFailure = conn.prepare(`UPDATE source_truth_spill_gc_queue SET attempts=attempts+1,
      last_error=?,updated_at=? WHERE locator=? AND status='pending'`)
    for (const item of pending) {
      if (!/^[0-9a-f-]+\.spill$/.test(item.locator) || path.basename(item.locator) !== item.locator) {
        markPendingFailure.run('invalid-locator', now, item.locator)
        failed += 1
        continue
      }
      if (references.referencedLocators.has(item.locator)) {
        markPendingFailure.run('shared-reference', now, item.locator)
        shared += 1
        continue
      }
      const filePath = path.join(root, item.locator)
      try {
        let existed = true
        try {
          const stat = await fs.lstat(filePath)
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe-file-type')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') existed = false
          else throw error
        }
        if (existed) {
          await fs.unlink(filePath)
          await syncDirectory(root)
        }
        markCompleted.run(now, item.locator)
        completed += 1
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        markPendingFailure.run(code ? `file-${code}` : 'file-cleanup-failed', now, item.locator)
        failed += 1
      }
    }
    const remaining = Number((conn.prepare("SELECT COUNT(*) AS count FROM source_truth_spill_gc_queue WHERE status='pending'").get() as { count: number }).count)
    if (completed || shared || failed) logAgentEvent(failed ? 'warn' : 'info', 'storage.spill.source_truth_gc', {
      pending: remaining, completed, sharedReference: shared, failed
    })
    return { pending: remaining, completed, shared, failed, classified, scanStatus }
  }, false) } catch (error) {
    if (error instanceof SpillRootFenceBusyError) {
      const pending = Number((conn.prepare("SELECT COUNT(*) AS count FROM source_truth_spill_gc_queue WHERE status='pending'").get() as { count: number }).count)
      const scanStatus = (conn.prepare("SELECT status FROM source_truth_spill_gc_scan_state WHERE root_key='user-data-spill'").get() as { status: 'pending' | 'complete' } | undefined)?.status ?? 'pending'
      return { pending, completed: 0, shared: 0, failed: 0, classified: 0, scanStatus }
    }
    throw error
  }
}

export function scheduleSourceTruthSpillGcMaintenance(
  db: AppDatabase,
  root: string,
  options: { intervalMs?: number; onResult?: (summary: SourceTruthSpillGcSummary | 'failed') => void } = {}
): () => void {
  const timer = setInterval(() => {
    void runSourceTruthSpillGcMaintenance(db, root).then((summary) => options.onResult?.(summary)).catch(() => options.onResult?.('failed'))
  }, options.intervalMs ?? 5 * 60 * 1000)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Retain only canonical-referenced degradable copies; source-of-truth objects are excluded by class. */
export async function runSpillRetentionMaintenance(
  db: AppDatabase,
  root: string,
  now = Date.now(),
  options: { onReferenceScan?: (stats: SpillReferenceScanStats) => void } = {}
): Promise<string[]> {
  const store = createSpillStore(root)
  return store.withSpillRootFence(async () => {
    const references = readCanonicalSpillReferences(getDbConnection(db))
    options.onReferenceScan?.(references.stats)
    const policy = resolveRetentionPolicyFromDb(db)
    const degradable = references.descriptors.filter(({ kind }) => kind === 'degradable')
    return store.pruneDegradableUnderFence(degradable, { retentionDays: policy.degradableSpillRetentionDays, now })
  })
}
