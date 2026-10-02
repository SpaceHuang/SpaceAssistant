import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { logAgentEvent } from '../agentLogger/agentLogger'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { resolveRetentionPolicyFromDb } from './retentionPolicy'
import { SpillContentUnavailableError, readSourceTruthSpillSync, type SpillDescriptor } from './spillProtocol'

export { SpillContentUnavailableError } from './spillProtocol'
export type { SpillDescriptor } from './spillProtocol'

export type SpillStore = ReturnType<typeof createSpillStore>

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

  return {
    root,
    async commitSourceTruth(payload: string, commitCanonicalLocator: (descriptor: SpillDescriptor) => void | Promise<void>): Promise<SpillDescriptor> {
      if (!payload.length) throw new Error('source-of-truth spill payload must not be empty')
      const descriptor = await writeObject('source-of-truth', payload)
      // Keep the durable file if the DB transaction fails: its commit result may be uncertain,
      // and a full-reference-scan orphan pass can safely reclaim it later.
      await commitCanonicalLocator(descriptor)
      return descriptor
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
      return writeObject('degradable', payload)
    },

    async readDegradable(descriptor: SpillDescriptor): Promise<string> {
      if (descriptor.kind !== 'degradable') throw new Error('expected degradable spill')
      try { return await readVerified(descriptor) } catch { return DEGRADED_PLACEHOLDER }
    },

    async pruneDegradable(descriptors: readonly SpillDescriptor[], options: { retentionDays: number; now?: number }): Promise<string[]> {
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
    },

    async reconcileOrphans(input: { referencedLocators: ReadonlySet<string>; fullReferenceScanComplete: boolean }): Promise<string[]> {
      if (!input.fullReferenceScanComplete) throw new Error('spill orphan reconciliation requires a full reference scan')
      const names = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
      const removed: string[] = []
      for (const name of names) {
        if (!name.endsWith('.spill') || input.referencedLocators.has(name)) continue
        await fs.rm(path.join(root, name), { force: true })
        removed.push(name)
      }
      return removed
    }
  }
}

function collectSpillDescriptors(value: unknown, output: SpillDescriptor[]): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectSpillDescriptors(item, output)
    return
  }
  const object = value as Record<string, unknown>
  if (object.version === 1 && (object.kind === 'source-of-truth' || object.kind === 'degradable') &&
    typeof object.locator === 'string' && typeof object.byteLength === 'number' && typeof object.sha256 === 'string' &&
    typeof object.createdAt === 'number' && typeof object.head === 'string' && typeof object.tail === 'string') {
    output.push(object as unknown as SpillDescriptor)
  }
  for (const item of Object.values(object)) collectSpillDescriptors(item, output)
}

/** Scan every canonical History payload before orphan deletion; malformed rows fail closed. */
export function readCanonicalSpillReferences(conn: DatabaseSync): { descriptors: SpillDescriptor[]; referencedLocators: Set<string> } {
  const rows = conn.prepare(`SELECT payload_json AS value FROM agent_history_events
    UNION ALL SELECT messages_json AS value FROM session_transcript_entries`).all() as Array<{ value: string }>
  const descriptors: SpillDescriptor[] = []
  for (const row of rows) collectSpillDescriptors(JSON.parse(row.value) as unknown, descriptors)
  return { descriptors, referencedLocators: new Set(descriptors.map(({ locator }) => locator)) }
}

export async function reconcileSpillOrphansAgainstCanonicalHistory(store: SpillStore, conn: DatabaseSync): Promise<string[]> {
  const references = readCanonicalSpillReferences(conn)
  return store.reconcileOrphans({ referencedLocators: references.referencedLocators, fullReferenceScanComplete: true })
}

/** Retain only canonical-referenced degradable copies; source-of-truth objects are excluded by class. */
export async function runSpillRetentionMaintenance(db: AppDatabase, root: string, now = Date.now()): Promise<string[]> {
  const references = readCanonicalSpillReferences(getDbConnection(db))
  const policy = resolveRetentionPolicyFromDb(db)
  const degradable = references.descriptors.filter(({ kind }) => kind === 'degradable')
  return createSpillStore(root).pruneDegradable(degradable, { retentionDays: policy.degradableSpillRetentionDays, now })
}
