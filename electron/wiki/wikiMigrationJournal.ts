import { createHash, randomUUID } from 'node:crypto'
import { withWikiWriteMutex } from './wikiWriteMutex'
import type { FileIdentity } from '../safeAtomicWrite'
import type { WikiFileStore } from './wikiFileStore'

export type WikiMigrationStep = 'pending' | 'written' | 'verified' | 'conflict' | 'rolled_back'
export interface WikiMigrationEntry {
  objectKind: string
  relativePath: string
  oldExists: boolean
  oldHash: string | null
  newHash: string
  backupPath?: string
  backupHash?: string
  stagingPath: string
  step: WikiMigrationStep
  rollbackStep?: 'pending' | 'restored'
}
export interface WikiMigrationManifest {
  formatVersion: 1
  migrationId: string
  status: 'prepared' | 'applying' | 'completed' | 'conflict' | 'rolling_back' | 'rolled_back'
  entries: WikiMigrationEntry[]
}

export class WikiMigrationJournalError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WikiMigrationJournalError' }
}

export function createWikiMigrationJournal(options: { store: WikiFileStore; markRecoveryRequired?: (lockHeld: boolean) => void | Promise<void> }) {
  const lockPath = `${options.store.root}/.wiki-domain-lock`

  return {
    prepare(changes: Array<{ objectKind: string; relativePath: string; newBytes: Buffer }>): Promise<WikiMigrationManifest> {
      return withWikiWriteMutex(lockPath, async () => {
        if (!changes.length) throw new WikiMigrationJournalError('wiki-migration-plan-empty')
        const migrationId = randomUUID()
        const entries: WikiMigrationEntry[] = []
        for (const [index, change] of changes.entries()) {
          const relativePath = normalizeTarget(options.store, change.relativePath)
          if (entries.some(entry => entry.relativePath === relativePath)) throw new WikiMigrationJournalError('wiki-migration-plan-duplicate-target')
          const oldSnapshot = await currentFile(options.store, relativePath)
          const oldBytes = oldSnapshot?.bytes
          const stagingPath = `.wiki-service/migrations/${migrationId}/staging/${index}.payload`
          await options.store.writeImmutable(stagingPath, change.newBytes)
          const entry: WikiMigrationEntry = {
            objectKind: change.objectKind,
            relativePath,
            oldExists: !!oldBytes,
            oldHash: oldBytes ? hash(oldBytes) : null,
            newHash: hash(change.newBytes),
            stagingPath,
            step: 'pending',
          }
          if (oldBytes) {
            entry.backupPath = `.wiki-service/migrations/${migrationId}/backup/${index}.bak`
            entry.backupHash = hash(oldBytes)
            await options.store.writeImmutable(entry.backupPath, oldBytes)
          }
          entries.push(entry)
        }
        const manifest: WikiMigrationManifest = { formatVersion: 1, migrationId, status: 'prepared', entries }
        await writeManifest(options.store, manifest)
        return structuredClone(manifest)
      })
    },

    read(migrationId: string): Promise<WikiMigrationManifest> { return readManifest(options.store, migrationId) },

    apply(migrationId: string, input: { crashAfterWriteIndex?: number } = {}): Promise<WikiMigrationManifest> {
      return withWikiWriteMutex(lockPath, async () => {
        const manifest = await readManifest(options.store, migrationId)
        if (manifest.status === 'completed') return manifest
        if (manifest.status === 'conflict' || manifest.status === 'rolled_back' || manifest.status === 'rolling_back') throw new WikiMigrationJournalError('wiki-migration-not-applicable')
        manifest.status = 'applying'
        await writeManifest(options.store, manifest)
        for (const [index, entry] of manifest.entries.entries()) {
          if (entry.step === 'verified') continue
          if (!(await entryMaterialsValid(options.store, entry))) return markConflict(manifest, entry)
          const current = await currentFile(options.store, entry.relativePath)
          const currentHash = current ? hash(current.bytes) : null
          if (entry.step === 'pending' && currentHash === entry.newHash) {
            entry.step = 'verified'
            await writeManifest(options.store, manifest)
            continue
          }
          if (entry.step === 'written' && currentHash === entry.newHash) {
            entry.step = 'verified'
            await writeManifest(options.store, manifest)
            continue
          }
          if (currentHash !== entry.oldHash) return markConflict(manifest, entry)
          const staged = await options.store.read(entry.stagingPath)
          await options.store.write(entry.relativePath, staged, current?.identity ?? null)
          if (input.crashAfterWriteIndex === index) throw new Error('injected migration crash after target write')
          entry.step = 'written'
          await writeManifest(options.store, manifest)
          const written = await options.store.read(entry.relativePath)
          if (hash(written) !== entry.newHash) return markConflict(manifest, entry)
          entry.step = 'verified'
          await writeManifest(options.store, manifest)
        }
        manifest.status = 'completed'
        await writeManifest(options.store, manifest)
        return structuredClone(manifest)
      })
    },

    rollback(migrationId: string): Promise<WikiMigrationManifest> {
      return withWikiWriteMutex(lockPath, async () => {
        const manifest = await readManifest(options.store, migrationId)
        if (manifest.status === 'rolled_back') return manifest
        if (manifest.status !== 'completed' && manifest.status !== 'rolling_back') throw new WikiMigrationJournalError('wiki-migration-not-applicable')
        manifest.status = 'rolling_back'
        await writeManifest(options.store, manifest)
        for (const entry of [...manifest.entries].reverse()) {
          if (entry.step === 'rolled_back') continue
          const current = await currentFile(options.store, entry.relativePath)
          const currentHash = current ? hash(current.bytes) : null
          if (currentHash === entry.oldHash && (entry.oldExists || current === undefined)) {
            entry.step = 'rolled_back'
            await writeManifest(options.store, manifest)
            continue
          }
          if (!current || currentHash !== entry.newHash) return markConflict(manifest, entry)
          if (entry.oldExists) {
            if (!entry.backupPath || !entry.backupHash) return markConflict(manifest, entry)
            const backup = await options.store.read(entry.backupPath)
            if (hash(backup) !== entry.backupHash || entry.backupHash !== entry.oldHash) return markConflict(manifest, entry)
            await options.store.write(entry.relativePath, backup, current.identity)
          } else {
            await options.store.remove(entry.relativePath, current.identity)
          }
          const restored = await currentFile(options.store, entry.relativePath)
          if ((entry.oldExists && (!restored || hash(restored.bytes) !== entry.oldHash)) || (!entry.oldExists && restored)) return markConflict(manifest, entry)
          entry.step = 'rolled_back'
          await writeManifest(options.store, manifest)
        }
        manifest.status = 'rolled_back'
        await writeManifest(options.store, manifest)
        return structuredClone(manifest)
      })
    },
  }

  async function markConflict(manifest: WikiMigrationManifest, entry: WikiMigrationEntry): Promise<never> {
    entry.step = 'conflict'
    manifest.status = 'conflict'
    await writeManifest(options.store, manifest)
    await options.markRecoveryRequired?.(true)
    throw new WikiMigrationJournalError('wiki-migration-conflict')
  }
}

async function currentFile(store: WikiFileStore, relativePath: string): Promise<{ bytes: Buffer; identity: FileIdentity } | undefined> {
  const before = await store.identity(relativePath)
  if (!before) return undefined
  const bytes = await store.read(relativePath)
  const after = await store.identity(relativePath)
  if (!after || !sameIdentity(before, after)) throw new WikiMigrationJournalError('wiki-migration-target-changed')
  return { bytes, identity: after }
}
async function entryMaterialsValid(store: WikiFileStore, entry: WikiMigrationEntry): Promise<boolean> {
  try {
    if (hash(await store.read(entry.stagingPath)) !== entry.newHash) return false
    if (!entry.oldExists) return entry.oldHash === null && entry.backupPath === undefined && entry.backupHash === undefined
    if (!entry.backupPath || !entry.backupHash || entry.backupHash !== entry.oldHash) return false
    return hash(await store.read(entry.backupPath)) === entry.backupHash
  } catch { return false }
}
function normalizeTarget(store: WikiFileStore, relativePath: string): string {
  const absolute = store.absolutePath(relativePath)
  return absolute.slice(store.root.length + 1).replace(/\\/g, '/')
}
async function readManifest(store: WikiFileStore, migrationId: string): Promise<WikiMigrationManifest> {
  if (!/^[0-9a-f-]{36}$/i.test(migrationId)) throw new WikiMigrationJournalError('wiki-migration-missing')
  try {
    const manifest = JSON.parse(await store.readText(`.wiki-service/migrations/${migrationId}.json`)) as WikiMigrationManifest
    if (manifest.formatVersion !== 1 || manifest.migrationId !== migrationId || !Array.isArray(manifest.entries)) throw new Error('invalid')
    return manifest
  } catch { throw new WikiMigrationJournalError('wiki-migration-missing') }
}
async function writeManifest(store: WikiFileStore, manifest: WikiMigrationManifest): Promise<void> {
  await store.write(`.wiki-service/migrations/${manifest.migrationId}.json`, `${JSON.stringify(manifest, null, 2)}\n`)
}
function hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink
}
