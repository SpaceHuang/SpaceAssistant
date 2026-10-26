import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import acquireFileLock from './projectionBlobLock'
import { runInTransaction } from '../../../database/transaction'
import { parseProjectionBuildCheckpoint, type ProjectionBuildReducerStateManifestRef, type ProjectionPendingHistoryChunkManifestRef } from '../../domain/projectionBuild'

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
    async withWorkerStaging<T>(run: (promote: (input: Readonly<{ tempLocator: string; locator?: string; byteLength: number; payloadDigest: string }>) => Promise<StagedProjectionBlob>,
      stage: Readonly<{ root: string; tempLocator: string; allocate(count: number): readonly string[] }>) => Promise<T>): Promise<T> {
      const releaseFence = await acquireFence()
      const tempLocators = new Set<string>()
      const firstTempLocator = `.projection-${randomUUID()}.tmp`
      tempLocators.add(firstTempLocator)
      const stage = Object.freeze({ root, tempLocator: firstTempLocator, allocate(count: number) {
        if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw blobError('PROJECTION_WORKER_STAGE_COUNT_INVALID', 'worker staging count is invalid')
        const locators = Array.from({ length: count }, () => `.projection-${randomUUID()}.tmp`)
        for (const locator of locators) tempLocators.add(locator)
        return Object.freeze(locators)
      } })
      let handedOff = false
      let released = false
      let runSucceeded = false
      try {
        const result = await run(async (input) => {
          if (!/^\.projection-[0-9a-f-]{36}\.tmp$/.test(input.tempLocator) || path.basename(input.tempLocator) !== input.tempLocator ||
            (input.locator !== undefined && (!/^projection-[0-9a-f-]{36}\.blob$/.test(input.locator) ||
              input.locator !== `${input.tempLocator.slice(1, -4)}.blob`)) ||
            !Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || !/^[a-f0-9]{64}$/.test(input.payloadDigest)) {
            throw blobError('PROJECTION_WORKER_BLOB_REFERENCE_INVALID', 'worker staging reference is invalid')
          }
          const tempPath = path.join(root, input.tempLocator)
          tempLocators.add(input.tempLocator)
          const stat = await fs.lstat(tempPath)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.byteLength) {
            throw blobError('PROJECTION_WORKER_BLOB_INVALID', 'worker staging file is invalid')
          }
          if (await digestFile(tempPath) !== input.payloadDigest) {
            throw blobError('PROJECTION_WORKER_BLOB_INVALID', 'worker staging digest is invalid')
          }
          const locator = input.locator ?? `projection-${randomUUID()}.blob`
          const finalPath = path.join(root, locator)
          if (await fs.lstat(finalPath).then(() => true, (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
            throw blobError('PROJECTION_WORKER_BLOB_TARGET_EXISTS', 'worker staging target already exists')
          }
          await fs.rename(tempPath, finalPath)
          tempLocators.delete(input.tempLocator)
          await fs.chmod(finalPath, 0o600)
          await syncDirectory(root)
          handedOff = true
          return Object.freeze({ locator, byteLength: input.byteLength, payloadDigest: input.payloadDigest,
            async release() { if (!released) { released = true; await releaseFence() } } })
        }, stage)
        runSucceeded = true
        return result
      } finally {
        let cleanupError: unknown
        for (const locator of tempLocators) {
          const tempPath = path.join(root, locator)
          try {
            const tempStat = await fs.lstat(tempPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error))
            if (tempStat && (!tempStat.isFile() || tempStat.isSymbolicLink())) {
              throw blobError('PROJECTION_WORKER_BLOB_INVALID', 'worker staging file is invalid')
            }
            await fs.rm(tempPath, { force: true })
          } catch (error) { cleanupError ??= error }
          }
        if ((!handedOff || !runSucceeded || cleanupError) && !released) { released = true; await releaseFence() }
        if (runSucceeded && cleanupError) throw cleanupError
      }
    },
    async withWorkerTransientStaging<T>(run: (stage: Readonly<{ root: string; tempLocator: string }>) => Promise<T>): Promise<T> {
      const releaseFence = await acquireFence()
      const tempLocator = `.projection-${randomUUID()}.tmp`
      let runFailed = false
      try {
        return await run(Object.freeze({ root, tempLocator }))
      } catch (error) {
        runFailed = true
        throw error
      } finally {
        let cleanupError: unknown
        try {
          const tempPath = path.join(root, tempLocator)
          const stat = await fs.lstat(tempPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          })
          if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
            throw blobError('PROJECTION_WORKER_TRANSIENT_STAGE_INVALID', 'worker transient staging file is invalid')
          }
          await fs.rm(tempPath, { force: true })
          if (stat) await syncDirectory(root)
        } catch (error) { cleanupError = error }
        try { await releaseFence() }
        catch (error) { cleanupError ??= error }
        if (!runFailed && cleanupError) throw cleanupError
      }
    },
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
      let operationFailed = false
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
      } catch (error) {
        operationFailed = true
        throw error
      } finally {
        for (const blob of staged) {
          await fs.rm(blob.tempPath, { force: true }).catch(() => undefined)
          if (!handedOffToCaller || !handedOff.has(blob.locator)) await fs.rm(blob.finalPath, { force: true }).catch(() => undefined)
        }
        if (!handedOffToCaller) {
          try { await releaseFence() }
          catch (error) { if (!operationFailed) throw error }
        }
      }
    },
    async readVerified(input: Readonly<{ locator: string; byteLength: number; payloadDigest: string }>): Promise<string> {
      const locator = assertLocator(input.locator)
      const releaseFence = await acquireFence()
      let operationFailed = false
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
      } catch (error) {
        operationFailed = true
        throw error
      } finally {
        try { await releaseFence() }
        catch (error) { if (!operationFailed) throw error }
      }
    },
    async withVerifiedReadStream<T>(
      input: Readonly<{ locator: string; byteLength: number; payloadDigest: string }>,
      consume: (stream: AsyncIterable<Buffer>) => Promise<T>
    ): Promise<T> {
      const locator = assertLocator(input.locator)
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || !/^[a-f0-9]{64}$/.test(input.payloadDigest)) {
        throw blobError('PROJECTION_BLOB_REFERENCE_INVALID', 'projection blob length or digest is invalid')
      }
      const releaseFence = await acquireFence()
      let operationFailed = false
      const filePath = path.join(root, locator)
      let source: ReturnType<typeof createReadStream> | undefined
      let verified: Transform | undefined
      try {
        const stat = await fs.lstat(filePath).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') throw blobError('PROJECTION_BLOB_MISSING', 'projection blob is missing')
          throw cause
        })
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.byteLength) {
          throw blobError('PROJECTION_BLOB_CORRUPT', 'projection blob type or length mismatch')
        }
        const hash = createHash('sha256')
        let bytesRead = 0
        source = createReadStream(filePath)
        verified = new Transform({ transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          bytesRead += chunk.byteLength
          hash.update(chunk)
          callback(null, chunk)
        }, flush(callback: TransformCallback) {
          if (bytesRead !== input.byteLength || hash.digest('hex') !== input.payloadDigest) {
            callback(blobError('PROJECTION_BLOB_CORRUPT', 'projection blob length or digest mismatch'))
            return
          }
          callback()
        } })
        source.once('error', (error) => verified?.destroy(error))
        source.pipe(verified)
        return await consume(verified)
      } catch (error) {
        operationFailed = true
        throw error
      } finally {
        source?.destroy()
        verified?.destroy()
        try { await releaseFence() }
        catch (error) { if (!operationFailed) throw error }
      }
    },
    async collectGarbage(conn: DatabaseSync, input: Readonly<{ afterLocator?: string; maxEntries?: number }> = {}): Promise<Readonly<{
      removedCount: number; removedBytes: number; nextLocator?: string
    }>> {
      const maxEntries = input.maxEntries ?? 4096
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) {
        throw blobError('PROJECTION_BLOB_GC_BUDGET_INVALID', 'projection blob GC entry budget is invalid')
      }
      if (input.afterLocator !== undefined && input.afterLocator !== '' && !/^\.?projection-[0-9a-f-]{36}\.(?:blob|tmp)$/.test(input.afterLocator)) {
        throw blobError('PROJECTION_BLOB_GC_CURSOR_INVALID', 'projection blob GC cursor is invalid')
      }
      const releaseFence = await acquireFence()
      let operationFailed = false
      try {
        const roots = runInTransaction(conn, () => {
          const locators = new Set<string>()
          const manifests: Array<{ locator: string; byteLength?: number; payloadDigest: string; sessionId: string; scopeKey: string; sourceIdentityJson: string; kind?: 'output' | 'stable-id-index' | 'final-view'; itemCount?: number }> = []
          const reducerStateManifests: ProjectionBuildReducerStateManifestRef[] = []
          const pendingChunkManifests: ProjectionPendingHistoryChunkManifestRef[] = []
          const bodyBlockReferences: Array<{ locator: string; byteLength: number; payloadDigest: string }> = []
          const sourceBodyReferences: Array<{ locator: string; byteLength: number; payloadDigest: string }> = []
          for (const row of conn.prepare(`SELECT locator,byte_length,payload_digest FROM session_projection_blob_references
            ORDER BY locator`).all() as Array<{ locator: string; byte_length: number; payload_digest: string }>) {
            try {
              const locator = assertLocator(row.locator)
              if (!Number.isSafeInteger(row.byte_length) || row.byte_length < 1 || !/^[a-f0-9]{64}$/.test(row.payload_digest)) {
                throw new Error('invalid body block metadata')
              }
              bodyBlockReferences.push({ locator, byteLength: row.byte_length, payloadDigest: row.payload_digest })
            } catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `invalid paged body blob reference: ${String(cause)}`) }
          }
          for (const row of conn.prepare(`SELECT fragment_locator AS locator,byte_length,sha256 AS payload_digest FROM session_message_body_locator
            UNION ALL
            SELECT manifest_locator AS locator,byte_length,sha256 AS payload_digest FROM session_body_source_manifest
            ORDER BY locator`).all() as Array<{ locator: string; byte_length: number; payload_digest: string }>) {
            try {
              const locator = assertLocator(row.locator)
              if (!Number.isSafeInteger(row.byte_length) || row.byte_length < 1 || !/^[a-f0-9]{64}$/.test(row.payload_digest)) {
                throw new Error('invalid source body metadata')
              }
              sourceBodyReferences.push({ locator, byteLength: row.byte_length, payloadDigest: row.payload_digest })
            } catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `invalid source body blob reference: ${String(cause)}`) }
          }
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
            if (checkpoint.historyReducerStateBlob) {
              try { reducerStateManifests.push({ ...checkpoint.historyReducerStateBlob,
                locator: assertLocator(checkpoint.historyReducerStateBlob.locator) }) }
              catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `invalid reducer state blob reference: ${String(cause)}`) }
            }
            if (checkpoint.pendingHistoryChunkBlob) {
              try { pendingChunkManifests.push({ ...checkpoint.pendingHistoryChunkBlob,
                locator: assertLocator(checkpoint.pendingHistoryChunkBlob.locator) }) }
              catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `invalid pending History chunk reference: ${String(cause)}`) }
            }
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
          return { locators, manifests, reducerStateManifests, pendingChunkManifests, bodyBlockReferences, sourceBodyReferences }
        })
        const referenced = roots.locators
        await retainOutputManifestChains(root, roots.manifests, referenced)
        for (const reference of roots.bodyBlockReferences) {
          let content: Buffer
          try { content = await fs.readFile(path.join(root, reference.locator)) }
          catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `paged body blob is unavailable: ${String(cause)}`) }
          if (content.byteLength !== reference.byteLength || digest(content) !== reference.payloadDigest) {
            throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'paged body blob failed reference verification')
          }
          referenced.add(reference.locator)
        }
        for (const reference of roots.sourceBodyReferences) {
          let content: Buffer
          try { content = await fs.readFile(path.join(root, reference.locator)) }
          catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `source body blob is unavailable: ${String(cause)}`) }
          if (content.byteLength !== reference.byteLength || digest(content) !== reference.payloadDigest) {
            throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'source body blob failed reference verification')
          }
          referenced.add(reference.locator)
        }
        for (const manifest of roots.reducerStateManifests) {
          let content: Buffer
          try { content = await fs.readFile(path.join(root, manifest.locator)) }
          catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `reducer state blob is unavailable: ${String(cause)}`) }
          if (content.byteLength !== manifest.byteLength || digest(content) !== manifest.payloadDigest) {
            throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'reducer state blob failed reference verification')
          }
          referenced.add(manifest.locator)
        }
        for (const manifest of roots.pendingChunkManifests) {
          let content: Buffer
          try { content = await fs.readFile(path.join(root, manifest.locator)) }
          catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `pending History chunk blob is unavailable: ${String(cause)}`) }
          if (content.byteLength !== manifest.byteLength || digest(content) !== manifest.payloadDigest) {
            throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History chunk blob failed reference verification')
          }
          referenced.add(manifest.locator)
          let pendingPayload: unknown
          try { pendingPayload = JSON.parse(content.toString('utf8')) }
          catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `pending History chunk JSON is invalid: ${String(cause)}`) }
          if (pendingPayload && typeof pendingPayload === 'object' &&
            (pendingPayload as { kind?: unknown }).kind === 'segmented-history-event') {
            const segmented = pendingPayload as { formatVersion?: unknown; messageSegments?: unknown; messageCount?: unknown;
              factSegments?: unknown; factCount?: unknown; requiredUserSegments?: unknown; requiredUserMessage?: unknown;
              requiredUserMessageRef?: unknown }
            if ((segmented.formatVersion !== 2 && segmented.formatVersion !== 3) || !Array.isArray(segmented.messageSegments) || segmented.messageSegments.length < 1 ||
              segmented.messageSegments.length > 15 || !Number.isSafeInteger(segmented.messageCount) ||
              (segmented.messageCount as number) < 1 || !Array.isArray(segmented.factSegments) ||
              segmented.factSegments.length > 15 ||
              (segmented.requiredUserSegments !== undefined && (!Array.isArray(segmented.requiredUserSegments) ||
                segmented.requiredUserSegments.length < 2)) ||
              (segmented.requiredUserMessageRef !== undefined && (segmented.formatVersion !== 3 || !segmented.requiredUserMessageRef ||
                typeof segmented.requiredUserMessageRef !== 'object' || Array.isArray(segmented.requiredUserMessageRef))) ||
              (segmented.requiredUserMessageRef !== undefined && (segmented.requiredUserMessage !== undefined ||
                segmented.requiredUserSegments !== undefined)) ||
              segmented.messageSegments.length + segmented.factSegments.length +
                (Array.isArray(segmented.requiredUserSegments) ? segmented.requiredUserSegments.length : 0) > 15 ||
              !Number.isSafeInteger(segmented.factCount) || (segmented.factCount as number) < 0) {
              throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending segmented History chunk shape is invalid')
            }
            if (segmented.requiredUserMessageRef !== undefined) {
              const reference = segmented.requiredUserMessageRef as { id?: unknown; messageIndex?: unknown }
              if (typeof reference.id !== 'string' || !reference.id.trim() || !Number.isSafeInteger(reference.messageIndex) ||
                (reference.messageIndex as number) < 0 || (reference.messageIndex as number) >= (segmented.messageCount as number)) {
                throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending required-user message reference is invalid')
              }
            }
            const segmentLocators = new Set<string>()
            let segmentBytes = 0
            let messageItems = 0
            let factItems = 0
            let requiredUserItems = 0
            const verifySegments = async (rawSegments: unknown[], kind: 'message' | 'fact' | 'required-user') => {
              let index = 0
              const items = () => kind === 'message' ? messageItems : kind === 'fact' ? factItems : requiredUserItems
              const addItems = (count: number) => {
                if (kind === 'message') messageItems += count
                else if (kind === 'fact') factItems += count
                else requiredUserItems += count
              }
              const readSegment = async (rawSegment: unknown) => {
                if (!rawSegment || typeof rawSegment !== 'object' || Array.isArray(rawSegment)) {
                  throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History segment reference is invalid')
                }
                const segment = rawSegment as { locator?: unknown; byteLength?: unknown; payloadDigest?: unknown; itemCount?: unknown;
                  encoding?: unknown; firstItemIndex?: unknown; fragmentIndex?: unknown; fragmentCount?: unknown }
                let locator: string
                try { locator = assertLocator(typeof segment.locator === 'string' ? segment.locator : '') }
                catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `invalid pending History segment locator: ${String(cause)}`) }
                if (segmentLocators.has(locator) || !Number.isSafeInteger(segment.byteLength) || (segment.byteLength as number) < 1 ||
                  (segment.byteLength as number) > 16 * 1024 * 1024 || typeof segment.payloadDigest !== 'string' ||
                  !/^[a-f0-9]{64}$/.test(segment.payloadDigest) || !Number.isSafeInteger(segment.itemCount) ||
                  (segment.itemCount as number) < 0 || (segment.encoding !== undefined && segment.encoding !== 'json-item-fragment')) {
                  throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History segment manifest is malformed')
                }
                let content: Buffer
                try { content = await fs.readFile(path.join(root, locator)) }
                catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `pending History segment is unavailable: ${String(cause)}`) }
                if (content.byteLength !== segment.byteLength || digest(content) !== segment.payloadDigest) {
                  throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History segment failed digest verification')
                }
                segmentLocators.add(locator)
                segmentBytes += content.byteLength
                if (segmentBytes > 128 * 1024 * 1024) {
                  throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History segmented payload exceeds byte budget')
                }
                referenced.add(locator)
                return { segment, content }
              }
              while (index < rawSegments.length) {
                const { segment, content } = await readSegment(rawSegments[index])
                if (segment.encoding !== 'json-item-fragment') {
                  if (kind === 'required-user') {
                    throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending required-user value must use JSON fragments')
                  }
                  if ((segment.itemCount as number) < 1 ||
                    (segment.firstItemIndex !== undefined && segment.firstItemIndex !== items())) {
                    throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History array segment index is invalid')
                  }
                  let payload: unknown
                  try { payload = JSON.parse(content.toString('utf8')) }
                  catch (cause) { throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', `pending History segment JSON is invalid: ${String(cause)}`) }
                  if (!Array.isArray(payload) || payload.length !== segment.itemCount) {
                    throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History segment shape is invalid')
                  }
                  addItems(payload.length)
                  index += 1
                  continue
                }
                const fragmentCount = segment.fragmentCount
                if (segment.firstItemIndex !== items() || segment.fragmentIndex !== 0 || segment.itemCount !== 1 ||
                  !Number.isSafeInteger(fragmentCount) || (fragmentCount as number) < 2 || (fragmentCount as number) > 15 ||
                  index + (fragmentCount as number) > rawSegments.length) {
                  throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History item fragment manifest is invalid')
                }
                for (let fragmentIndex = 1; fragmentIndex < (fragmentCount as number); fragmentIndex += 1) {
                  const next = await readSegment(rawSegments[index + fragmentIndex])
                  if (next.segment.encoding !== 'json-item-fragment' || next.segment.firstItemIndex !== segment.firstItemIndex ||
                    next.segment.fragmentIndex !== fragmentIndex || next.segment.fragmentCount !== fragmentCount || next.segment.itemCount !== 0) {
                    throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History item fragments are not contiguous')
                  }
                }
                addItems(1)
                index += fragmentCount as number
              }
            }
            await verifySegments(segmented.messageSegments as unknown[], 'message')
            await verifySegments(segmented.factSegments as unknown[], 'fact')
            if (Array.isArray(segmented.requiredUserSegments)) {
              await verifySegments(segmented.requiredUserSegments, 'required-user')
              if (requiredUserItems !== 1) {
                throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending required-user item count is invalid')
              }
            }
            if (messageItems !== segmented.messageCount || factItems !== segmented.factCount || segmentBytes > 128 * 1024 * 1024) {
              throw blobError('PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE', 'pending History segmented payload totals are invalid')
            }
          }
        }
        const names = (await fs.readdir(root)).filter((name) => /^projection-[0-9a-f-]{36}\.blob$/.test(name) || /^\.projection-[0-9a-f-]{36}\.tmp$/.test(name))
          .filter((name) => !input.afterLocator || name > input.afterLocator).sort()
        const page = names.slice(0, maxEntries)
        let removedCount = 0
        let removedBytes = 0
        for (const name of page) {
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
        return Object.freeze({ removedCount, removedBytes, ...(names.length > maxEntries ? { nextLocator: page.at(-1) } : {}) })
      } catch (error) {
        operationFailed = true
        throw error
      } finally {
        try { await releaseFence() }
        catch (error) { if (!operationFailed) throw error }
      }
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

async function digestFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
