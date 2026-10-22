import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import acquireFileLock from './projectionBlobLock'
import { runInTransaction } from '../../../database/transaction'
import { parseProjectionBuildCheckpoint } from '../../domain/projectionBuild'

export type StagedProjectionBlob = Readonly<{
  locator: string
  byteLength: number
  payloadDigest: string
  release(): Promise<void>
}>


function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function blobError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function assertLocator(locator: string): string {
  if (!/^projection-[0-9a-f-]{36}\.blob$/.test(locator) || path.basename(locator) !== locator) {
    throw blobError('PROJECTION_BLOB_LOCATOR_INVALID', 'projection blob locator is invalid')
  }
  return locator
}

export function createSessionProjectionBlobStore(root: string) {
  async function acquireFence(): Promise<() => Promise<void>> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    await fs.chmod(root, 0o700)
    return acquireFileLock(root, { realpath: false, stale: 30_000, update: 10_000,
      retries: { retries: 12, minTimeout: 5, maxTimeout: 80, factor: 1.5 } })
  }

  return {
    root,
    async write(payload: string): Promise<StagedProjectionBlob> {
      const [blob] = await this.writeMany([payload])
      return blob!
    },
    async writeMany(payloads: readonly string[]): Promise<readonly StagedProjectionBlob[]> {
      if (payloads.length < 1 || payloads.some((payload) => typeof payload !== 'string')) {
        throw blobError('PROJECTION_BLOB_BATCH_INVALID', 'projection blob batch must contain strings')
      }
      const releaseFence = await acquireFence()
      const staged = payloads.map((payload) => {
        const bytes = Buffer.from(payload, 'utf8')
        return { bytes, locator: `projection-${randomUUID()}.blob`, tempPath: path.join(root, `.projection-${randomUUID()}.tmp`),
          finalPath: '' }
      })
      for (const blob of staged) blob.finalPath = path.join(root, blob.locator)
      const handedOff = new Set<string>()
      let released = false
      let handedOffToCaller = false
      try {
        for (const blob of staged) {
          const file = await fs.open(blob.tempPath, 'wx', 0o600)
          try { await file.writeFile(blob.bytes); await file.sync() } finally { await file.close() }
          await fs.rename(blob.tempPath, blob.finalPath)
          await fs.chmod(blob.finalPath, 0o600)
          const persisted = await fs.readFile(blob.finalPath)
          if (persisted.byteLength !== blob.bytes.byteLength || digest(persisted) !== digest(blob.bytes)) {
            throw blobError('PROJECTION_BLOB_CORRUPT', 'projection blob verification failed')
          }
          handedOff.add(blob.locator)
        }
        await syncDirectory(root)
        const result = Object.freeze(staged.map((blob) => Object.freeze({ locator: blob.locator, byteLength: blob.bytes.byteLength,
          payloadDigest: digest(blob.bytes), async release() { if (!released) { released = true; await releaseFence() } } })))
        handedOffToCaller = true
        return result
      } finally {
        for (const blob of staged) {
          await fs.rm(blob.tempPath, { force: true }).catch(() => undefined)
          if (!handedOffToCaller || !handedOff.has(blob.locator)) await fs.rm(blob.finalPath, { force: true }).catch(() => undefined)
        }
        if (!handedOffToCaller) {
          await releaseFence()
        }
      }
    },
    async readVerified(input: Readonly<{ locator: string; byteLength: number; payloadDigest: string }>): Promise<string> {
      const locator = assertLocator(input.locator)
      const releaseFence = await acquireFence()
      try {
        let content: Buffer
        try { content = await fs.readFile(path.join(root, locator)) }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') throw blobError('PROJECTION_BLOB_MISSING', 'projection blob is missing')
          throw cause
        }
        if (content.byteLength !== input.byteLength || digest(content) !== input.payloadDigest) {
          throw blobError('PROJECTION_BLOB_CORRUPT', 'projection blob length or digest mismatch')
        }
        return content.toString('utf8')
      } finally { await releaseFence() }
    },
    async collectGarbage(conn: DatabaseSync): Promise<Readonly<{ removedCount: number; removedBytes: number }>> {
      const releaseFence = await acquireFence()
      try {
        const roots = runInTransaction(conn, () => {
          const locators = new Set<string>()
          const manifests: Array<{ locator: string; byteLength?: number; payloadDigest: string; sessionId: string; scopeKey: string; sourceIdentityJson: string; kind?: 'output' | 'stable-id-index' | 'final-view'; itemCount?: number }> = []
          for (const row of conn.prepare('SELECT session_id,scope_key,source_identity_json,blob_locator,blob_byte_length,payload_digest FROM session_projection_cache WHERE blob_locator IS NOT NULL').all() as Array<{ session_id: string; scope_key: string; source_identity_json: string; blob_locator: string; blob_byte_length: number; payload_digest: string }>) {
            try {
              manifests.push({ locator: assertLocator(row.blob_locator), byteLength: row.blob_byte_length, payloadDigest: row.payload_digest,
                sessionId: row.session_id, scopeKey: row.scope_key, sourceIdentityJson: row.source_identity_json, kind: 'final-view' })
            }
            catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `invalid cache blob reference: ${String(cause)}`) }
          }
          for (const row of conn.prepare('SELECT build_checkpoint_json FROM session_projection_state WHERE build_checkpoint_json IS NOT NULL').all() as Array<{ build_checkpoint_json: string }>) {
            const checkpoint = parseProjectionBuildCheckpoint(row.build_checkpoint_json)
            if (!checkpoint) throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'invalid durable build checkpoint')
            if (checkpoint.outputManifest) {
              try { manifests.push({ ...checkpoint.outputManifest, locator: assertLocator(checkpoint.outputManifest.locator),
                sessionId: checkpoint.sessionId, scopeKey: checkpoint.scopeKey, sourceIdentityJson: checkpoint.sourceIdentityJson, kind: 'output' }) }
              catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `invalid checkpoint output manifest reference: ${String(cause)}`) }
            }
            if (checkpoint.stableIdIndexManifest) {
              try { manifests.push({ ...checkpoint.stableIdIndexManifest, itemCount: checkpoint.stableIdIndexManifest.itemCount, locator: assertLocator(checkpoint.stableIdIndexManifest.locator),
                sessionId: checkpoint.sessionId, scopeKey: checkpoint.scopeKey, sourceIdentityJson: checkpoint.sourceIdentityJson, kind: 'stable-id-index' }) }
              catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `invalid stable-ID index manifest reference: ${String(cause)}`) }
            }
          }
          return { locators, manifests }
        })
        const referenced = roots.locators
        await retainOutputManifestChains(root, roots.manifests, referenced)
        const names = await fs.readdir(root)
        let removedCount = 0
        let removedBytes = 0
        for (const name of names) {
          const isBlob = /^projection-[0-9a-f-]{36}\.blob$/.test(name)
          const isTemp = /^\.projection-[0-9a-f-]{36}\.tmp$/.test(name)
          if ((!isBlob && !isTemp) || referenced.has(name)) continue
          const filePath = path.join(root, name)
          const stat = await fs.lstat(filePath)
          if (stat.isSymbolicLink() || !stat.isFile()) continue
          await fs.unlink(filePath)
          if (isBlob) { removedCount += 1; removedBytes += stat.size }
        }
        if (removedCount > 0) await syncDirectory(root)
        return Object.freeze({ removedCount, removedBytes })
      } finally { await releaseFence() }
    }
  }
}

async function retainOutputManifestChains(
  root: string,
  roots: readonly Readonly<{ locator: string; byteLength?: number; payloadDigest: string; sessionId: string; scopeKey: string; sourceIdentityJson: string; kind?: 'output' | 'stable-id-index' | 'final-view'; itemCount?: number }>[],
  referenced: Set<string>
): Promise<void> {
  const completed = new Map<string, string>()
  const visit = async (reference: Readonly<{ locator: string; byteLength?: number; payloadDigest: string; sessionId: string; scopeKey: string; sourceIdentityJson: string; kind?: 'output' | 'stable-id-index' | 'final-view'; itemCount?: number }>): Promise<void> => {
    let current: Readonly<{ locator: string; byteLength?: number; payloadDigest: string }> | null = reference
    const chain = new Set<string>()
    while (current) {
      const locator = assertLocator(current.locator)
      if (chain.has(locator)) throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'output manifest chain contains a cycle')
      chain.add(locator)
      const priorDigest = completed.get(locator)
      if (priorDigest !== undefined) {
        if (priorDigest !== current.payloadDigest) throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'output manifest locator has conflicting digests')
        if (current.byteLength !== undefined) {
          const stat = await fs.stat(path.join(root, locator)).catch(() => undefined)
          if (!stat || stat.size !== current.byteLength) throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'output manifest locator has conflicting lengths')
        }
        return
      }
      let bytes: Buffer
      try { bytes = await fs.readFile(path.join(root, locator)) }
      catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `referenced output manifest is missing: ${String(cause)}`) }
      if ((current.byteLength !== undefined && bytes.byteLength !== current.byteLength) || digest(bytes) !== current.payloadDigest) {
        throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'referenced output manifest failed length or digest verification')
      }
      let payload: unknown
      try { payload = JSON.parse(bytes.toString('utf8')) } catch { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'referenced output manifest is invalid JSON') }
      const manifest = payload && typeof payload === 'object' ? (payload as { outputManifest?: unknown }).outputManifest : undefined
      if (reference.kind === 'stable-id-index') {
        const index = payload && typeof payload === 'object' ? payload as { formatVersion?: unknown; messageCount?: unknown; ids?: unknown; entries?: unknown } : undefined
        if (!index || index.formatVersion !== 1 || index.messageCount !== reference.itemCount ||
          !Array.isArray(index.ids) || index.ids.length !== reference.itemCount ||
          new Set(index.ids).size !== index.ids.length || index.ids.some((id) => typeof id !== 'string' || !id.trim()) ||
          !Array.isArray(index.entries) || index.entries.length !== index.ids.length || index.entries.some((entry, ordinal) =>
            !entry || typeof entry !== 'object' || (entry as { id?: unknown }).id !== (index.ids as unknown[])[ordinal] ||
            typeof (entry as { role?: unknown }).role !== 'string' || !(entry as { role: string }).role.trim() ||
            (entry as { ordinal?: unknown }).ordinal !== ordinal)) {
          throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'referenced stable-ID index is invalid')
        }
        const output = payload as { sessionId?: unknown; scopeKey?: unknown; sourceIdentityJson?: unknown }
        if (output.sessionId !== reference.sessionId || output.scopeKey !== reference.scopeKey || output.sourceIdentityJson !== reference.sourceIdentityJson) {
          throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'stable-ID index root identity does not match its durable owner')
        }
        referenced.add(locator)
        completed.set(locator, current.payloadDigest)
        return
      }
      if (reference.kind === 'final-view') {
        const view = payload && typeof payload === 'object' ? payload as { formatVersion?: unknown; scopeKey?: unknown; sessionGeneration?: unknown; messages?: unknown } : undefined
        if (!view || view.formatVersion !== 1 || view.scopeKey !== reference.scopeKey || view.sessionGeneration === undefined || !Array.isArray(view.messages)) {
          throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'referenced final view payload is invalid')
        }
        const owner = payload as { sessionId?: unknown; sourceIdentityJson?: unknown }
        if (owner.sessionId !== reference.sessionId || owner.sourceIdentityJson !== reference.sourceIdentityJson) {
          throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'final view root identity does not match its durable owner')
        }
        referenced.add(locator)
        completed.set(locator, current.payloadDigest)
        return
      }
      if (!manifest || typeof manifest !== 'object' || (manifest as { formatVersion?: unknown }).formatVersion !== 1 ||
        !Array.isArray((manifest as { operations?: unknown }).operations)) {
        throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'referenced blob is not a supported output manifest')
      }
      const output = payload as { formatVersion?: unknown; sessionId?: unknown; scopeKey?: unknown; sourceIdentityJson?: unknown }
      if (output.formatVersion !== 2 || output.sessionId !== reference.sessionId || output.scopeKey !== reference.scopeKey ||
        output.sourceIdentityJson !== reference.sourceIdentityJson) {
        throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'output manifest root identity does not match its durable owner')
      }
      referenced.add(locator)
      completed.set(locator, current.payloadDigest)
      const parent = (manifest as { parent?: unknown }).parent
      if (parent === null) return
      if (!parent || typeof parent !== 'object' || typeof (parent as { locator?: unknown }).locator !== 'string' ||
        !Number.isSafeInteger((parent as { byteLength?: unknown }).byteLength) ||
        typeof (parent as { payloadDigest?: unknown }).payloadDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test((parent as { payloadDigest: string }).payloadDigest)) {
        throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'output manifest parent reference is invalid')
      }
      current = parent as { locator: string; byteLength: number; payloadDigest: string }
    }
  }
  for (const reference of roots) await visit(reference)
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try { handle = await fs.open(directory, 'r'); await handle.sync() }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(String(code))) throw error
  } finally { await handle?.close().catch(() => undefined) }
}
