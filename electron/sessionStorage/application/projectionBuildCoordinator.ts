import {
  acceptProjectionBuildChunk, attachProjectionStableIdIndexManifest, createProjectionBuildCheckpoint, parseProjectionBuildCheckpoint,
  projectionPayloadDigest, takeoverProjectionBuildCheckpoint, type ProjectionBuildCheckpoint, type ProjectionBuildChunkReceipt,
  attachProjectionPendingHistoryChunk, type ProjectionBuildLimits, type ProjectionBuildReducerStateManifestRef,
  type ProjectionPendingHistoryChunkManifestRef,
} from '../domain/projectionBuild'
import type { SessionProjectionService, ProjectionRebuildLease } from './projectionService'
import type { ProjectionHistoryChunkEvent, ProjectionHistoryChunkPermit, ProjectionHistoryChunkResult, ProjectionMessageFact,
  ProjectionWorkerSample } from '../domain/projectionSource'
import { materializeProjectionOutputManifest, type ProjectionOutputBlobReader, type ProjectionOutputIdentity } from './projectionOutputManifest'

export type ProjectionBuildBlobPort = Readonly<{
  root?: string
  withWorkerStaging?<T>(run: (promote: (input: Readonly<{ tempLocator: string; locator?: string; byteLength: number; payloadDigest: string }>) => Promise<Readonly<{
    locator: string; byteLength: number; payloadDigest: string; release(): Promise<void>
  }>>, stage: Readonly<{ root: string; tempLocator: string; allocate(count: number): readonly string[] }>) => Promise<T>): Promise<T>
  write(payload: string): Promise<Readonly<{ locator: string; byteLength: number; payloadDigest: string; release(): Promise<void> }>>
  writeMany?(payloads: readonly string[]): Promise<readonly Readonly<{ locator: string; byteLength: number; payloadDigest: string; release(): Promise<void> }> []>
  readVerified?(input: Readonly<{ locator: string; byteLength: number; payloadDigest: string }>): Promise<string>
  materializeFinalView?(output: Readonly<{ locator: string; byteLength: number; payloadDigest: string }>,
    identity: ProjectionOutputIdentity, historyWatermarkJson: unknown, signal?: AbortSignal): Promise<Readonly<{
      payload?: string
      blob?: Readonly<{ locator: string; byteLength: number; payloadDigest: string; release(): Promise<void> }>
      byteLength: number
      payloadDigest: string
    }>>
}>
const MAX_DERIVED_CHUNK_BLOB_BYTES = 256 * 1024 * 1024
const MAX_STAGED_OUTPUT_MANIFEST_SEGMENTS = 14
const DEFAULT_PROJECTION_RETRY_DELAY_MS = 60_000

export type ProjectionHistoryChunkReaderPort = (
  permit: ProjectionHistoryChunkPermit,
  input: Readonly<{ afterSessionSequence: number; maxRows: number; maxBytes: number; signal?: AbortSignal;
    staging?: Readonly<{ root: string; tempLocator: string }> }>
) => Promise<ProjectionHistoryChunkResult>

export type ProjectionHistoryReducerPort = Readonly<{
  createState(scopeKey?: string): string
  fold(stateJson: string, events: readonly ProjectionHistoryChunkEvent[], messageFacts?: readonly ProjectionMessageFact[], scopeKey?: string): Readonly<{ stateJson: string; outputOperations: readonly unknown[]; resetOutput: boolean }>
  finalize(stateJson: string, scopeKey?: string): Readonly<{ outputOperations: readonly unknown[] }>
}>

export type ProjectionHistoryChunkReduction =
  | Readonly<{ stateJson: string; outputOperations: readonly unknown[]; resetOutput: boolean;
      finalizedOutputOperations?: readonly unknown[]; workerThreadId?: number; workerSample?: ProjectionWorkerSample }>
  | Readonly<{ resetOutput: boolean; stateJson?: string; stagedArtifacts: Readonly<{
    outputManifests: readonly Readonly<{ tempLocator: string; locator: string; byteLength: number; payloadDigest: string }>[]
    stableIdIndex: Readonly<{ tempLocator: string; locator: string; byteLength: number; payloadDigest: string; itemCount: number }>
    reducerState?: Readonly<{ tempLocator: string; locator: string; byteLength: number; payloadDigest: string }>
  }>; workerThreadId?: number; workerSample?: ProjectionWorkerSample }>
export type ProjectionHistoryChunkReducerPort = (
  stateJson: string,
  events: readonly ProjectionHistoryChunkEvent[],
  messageFacts: readonly ProjectionMessageFact[],
  scopeKey: string,
  finalize: boolean,
  signal?: AbortSignal,
  stagedChunk?: Readonly<{ root: string; manifest: ProjectionPendingHistoryChunkManifestRef }>,
  staging?: ProjectionReducerArtifactStaging
) => Promise<ProjectionHistoryChunkReduction>

export type ProjectionReducerArtifactStaging = Readonly<{
  root: string
  outputManifestTempLocators: readonly string[]
  stableIdIndexTempLocator: string
  reducerStateTempLocator: string
  context: Readonly<{
    sessionId: string
    sessionGeneration: string
    scopeKey: string
    specVersion: number
    sourceIdentityJson: string
    parentOutputManifest: ProjectionBuildCheckpoint['outputManifest']
    priorStableIdIndex: ProjectionBuildCheckpoint['stableIdIndexManifest']
    priorReducerState: ProjectionBuildCheckpoint['historyReducerStateBlob']
  }>
}>

export type ProjectionBuildSliceResult =
  | Readonly<{ kind: 'checkpointed'; checkpoint: ProjectionBuildCheckpoint }>
  | Readonly<{ kind: 'published'; checkpoint: ProjectionBuildCheckpoint; state: NonNullable<ReturnType<SessionProjectionService['get']>> }>
  | Readonly<{ kind: 'publish-unknown'; checkpoint: ProjectionBuildCheckpoint }>
  | Readonly<{ kind: 'source-drift' }>
  | Readonly<{ kind: 'deferred-large'; eventSequence?: number }>
  | Readonly<{ kind: 'lease-lost' | 'chunk-invalid' | 'blob-write-failed' | 'checkpoint-invalid' | 'source-unavailable'; reason?: string }>

export async function runProjectionBuildSlice(input: Readonly<{
  service: SessionProjectionService
  lease: ProjectionRebuildLease
  specVersion: number
  dbPath: string
  readChunk: ProjectionHistoryChunkReaderPort
  historyReducer: ProjectionHistoryReducerPort
  /** Production supplies the worker-backed reducer; synchronous reducer remains for deterministic unit ports. */
  reduceChunk?: ProjectionHistoryChunkReducerPort
  blobs: ProjectionBuildBlobPort
  limits: ProjectionBuildLimits
  maxChunksPerSlice: number
  now(): number
  retryAfter?(): number
  signal?: AbortSignal
}>): Promise<ProjectionBuildSliceResult> {
  const { service, lease, limits } = input
  if (!Number.isSafeInteger(input.specVersion) || input.specVersion < 1 || !input.dbPath ||
    !Number.isSafeInteger(limits.maxRows) || limits.maxRows < 1 || limits.maxRows > 200 ||
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 256 || limits.maxBytes > 256 * 1024 ||
    !Number.isSafeInteger(input.maxChunksPerSlice) || input.maxChunksPerSlice < 1) {
    rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'BUILD_BUDGET_INVALID', input.now, input.retryAfter)
    return { kind: 'chunk-invalid', reason: 'invalid-build-budget-or-scope' }
  }

  const invalidateInvalidCheckpoint = (): ProjectionBuildSliceResult =>
    service.invalidateLease(lease) ? { kind: 'checkpoint-invalid' } : { kind: 'lease-lost' }

  let checkpoint: ProjectionBuildCheckpoint
  const persisted = service.readCheckpoint(lease.sessionId, lease.scopeKey)
  const parsed = persisted ? parseProjectionBuildCheckpoint(persisted) : null
  if (persisted && !parsed) return invalidateInvalidCheckpoint()
  if (parsed) {
    if (parsed.sessionId !== lease.sessionId || parsed.sessionGeneration !== lease.sessionGeneration ||
      parsed.scopeKey !== lease.scopeKey || parsed.specVersion !== input.specVersion || parsed.sourceIdentityJson !== lease.sourceIdentityJson) {
      return invalidateInvalidCheckpoint()
    }
    const transferred = parsed.processGeneration === lease.processGeneration && parsed.rebuildToken === lease.rebuildToken
      ? parsed
      : takeoverProjectionBuildCheckpoint(parsed, { processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken,
        sourceIdentityJson: lease.sourceIdentityJson })
    if (!transferred) return invalidateInvalidCheckpoint()
    checkpoint = transferred
    if (persisted !== JSON.stringify(checkpoint) && !service.saveCheckpoint(lease, JSON.stringify(checkpoint))) return { kind: 'lease-lost' }
  } else {
    let initialStateJson: string
    try { initialStateJson = input.historyReducer.createState(lease.scopeKey) }
    catch (error) {
      rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'PROJECTION_SCOPE_REDUCER_UNSUPPORTED', input.now, input.retryAfter)
      return { kind: 'chunk-invalid', reason: error instanceof Error ? error.message : 'projection-scope-reducer-unsupported' }
    }
    checkpoint = createProjectionBuildCheckpoint({ sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration,
      scopeKey: lease.scopeKey, specVersion: input.specVersion, sourceIdentityJson: lease.sourceIdentityJson,
      processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken, startSequence: 0,
      historyReducerStateJson: initialStateJson })
    if (!service.saveCheckpoint(lease, JSON.stringify(checkpoint))) return { kind: 'lease-lost' }
  }

  let reducerStateJson = checkpoint.historyReducerStateJson
  if (!reducerStateJson && checkpoint.historyReducerStateBlob) {
    const workerCanReadState = Boolean(input.reduceChunk && input.blobs.withWorkerStaging && input.blobs.root)
    if (!workerCanReadState) {
      if (!input.blobs.readVerified) return invalidateInvalidCheckpoint()
      try {
        const ref = checkpoint.historyReducerStateBlob
        const restored = await input.blobs.readVerified(ref)
        if (Buffer.byteLength(restored) !== ref.byteLength || await projectionPayloadDigest(restored) !== ref.payloadDigest ||
          !isJsonString(restored)) return invalidateInvalidCheckpoint()
        reducerStateJson = restored
      } catch { return invalidateInvalidCheckpoint() }
    }
  }

  for (let index = 0; index < input.maxChunksPerSlice; index += 1) {
    const permit: ProjectionHistoryChunkPermit = {
      dbPath: input.dbPath, sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration,
      scopeKey: lease.scopeKey, specVersion: input.specVersion, sourceIdentityJson: lease.sourceIdentityJson,
      connectionEpoch: lease.connectionEpoch, processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken,
    }
    let result: ProjectionHistoryChunkResult
    const pendingChunk = checkpoint.pendingHistoryChunkBlob
    if (pendingChunk) {
      result = { kind: 'chunk', permit, afterSessionSequence: pendingChunk.fromSequence,
        nextSessionSequence: pendingChunk.nextSequence, events: [], messageFacts: [],
        byteLength: pendingChunk.sourceBytes, hasMore: pendingChunk.hasMore }
    } else {
      try {
        const readInput = { afterSessionSequence: checkpoint.nextSequence, maxRows: limits.maxRows, maxBytes: limits.maxBytes - 128,
          ...(input.signal ? { signal: input.signal } : {}) }
        let stagedResult: ProjectionHistoryChunkResult | undefined
        let earlyResult: ProjectionBuildSliceResult | undefined
        if (input.blobs.withWorkerStaging) {
          stagedResult = await input.blobs.withWorkerStaging(async (promote, stage) => {
            const source = await input.readChunk(permit, { ...readInput, staging: { root: stage.root, tempLocator: stage.tempLocator } })
            if (source.kind !== 'staged-chunk') return source
            if (!samePermit(source.permit, permit)) return source
            const blob = await promote(source.stagedBlob)
            const pending = attachProjectionPendingHistoryChunk(checkpoint, {
              locator: blob.locator, byteLength: blob.byteLength, payloadDigest: blob.payloadDigest,
              sessionId: lease.sessionId, scopeKey: lease.scopeKey, sourceIdentityJson: lease.sourceIdentityJson,
              fromSequence: source.afterSessionSequence, nextSequence: source.nextSessionSequence,
              rowCount: source.rowCount, sourceBytes: source.sourceByteLength, hasMore: source.hasMore,
            })
            if (!pending) {
              await blob.release()
              earlyResult = invalidateInvalidCheckpoint()
              return source
            }
            if (!service.saveCheckpoint(lease, JSON.stringify(pending))) {
              await blob.release()
              earlyResult = { kind: 'lease-lost' }
              return source
            }
            checkpoint = pending
            earlyResult = { kind: 'checkpointed', checkpoint }
            await blob.release()
            return source
          })
        } else stagedResult = await input.readChunk(permit, readInput)
        if (earlyResult) return earlyResult
        result = stagedResult!
      } catch (error) {
        if (input.signal?.aborted) return { kind: 'checkpointed', checkpoint }
        const failure = error instanceof Error ? error.message : 'projection-history-worker-failed'
        rejectBuild(service, lease, 'CONTENT_UNAVAILABLE', 'WORKER_FAILED', input.now, input.retryAfter)
        return { kind: 'source-unavailable', reason: failure }
      }
    }
    if (!samePermit(result.permit, permit)) {
      rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'WORKER_PERMIT_MISMATCH', input.now, input.retryAfter)
      return { kind: 'chunk-invalid', reason: 'worker-permit-mismatch' }
    }
    if (result.kind === 'source-drift') {
      service.invalidateLease(lease)
      return { kind: 'source-drift' }
    }
    if (result.kind === 'deferred-large') {
      rejectBuild(service, lease, 'CONTENT_UNAVAILABLE', 'DEFERRED_LARGE', input.now, input.retryAfter,
        result.eventSequence === undefined ? undefined : { eventSequence: result.eventSequence })
      return { kind: 'deferred-large', ...(result.eventSequence === undefined ? {} : { eventSequence: result.eventSequence }) }
    }
    if (result.kind === 'staged-chunk') {
      rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'STAGED_CHUNK_PROMOTION_UNAVAILABLE', input.now, input.retryAfter)
      return { kind: 'source-unavailable', reason: 'staged-chunk-promotion-unavailable' }
    }
    if (result.kind === 'cursor-invalid') {
      rejectBuild(service, lease, 'SOURCE_FENCE_CHANGED', 'SOURCE_CURSOR_INVALID', input.now, input.retryAfter)
      return { kind: 'source-unavailable', reason: 'cursor-invalid' }
    }
    if (result.kind === 'unavailable') {
      rejectBuild(service, lease, 'CONTENT_UNAVAILABLE', 'SOURCE_UNAVAILABLE', input.now, input.retryAfter)
      return { kind: 'source-unavailable', reason: result.reason ?? result.kind }
    }
    if (result.kind === 'complete') {
      const output = checkpoint.outputManifest
      if (checkpoint.nextSequence > 0 && !output) return invalidateInvalidCheckpoint()
      let payload: string
      let payloadByteLength: number
      let payloadDigest: string
      let workerFinalBlob: Awaited<ReturnType<NonNullable<ProjectionBuildBlobPort['materializeFinalView']>>>['blob']
      if (output) {
        const identity = { sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration, scopeKey: lease.scopeKey,
          specVersion: input.specVersion, sourceIdentityJson: lease.sourceIdentityJson }
        const historyWatermarkJson = (JSON.parse(lease.sourceIdentityJson) as { historyWatermark?: unknown }).historyWatermark ?? null
        if (input.blobs.materializeFinalView) {
          try {
            const materialized = await input.blobs.materializeFinalView(output, identity, historyWatermarkJson, input.signal)
            payload = materialized.payload ?? ''
            payloadByteLength = materialized.byteLength
            payloadDigest = materialized.payloadDigest
            workerFinalBlob = materialized.blob
            if (workerFinalBlob && materialized.payload !== undefined) throw new Error('PROJECTION_FINAL_VIEW_RESULT_AMBIGUOUS')
            if (!workerFinalBlob && typeof materialized.payload !== 'string') throw new Error('PROJECTION_FINAL_VIEW_RESULT_INVALID')
          } catch (error) {
            if (input.signal?.aborted || (error instanceof Error && /WORKER_ABORTED$/.test(error.message))) {
              return { kind: 'checkpointed', checkpoint }
            }
            const reason = error instanceof Error ? error.message : 'final-view-materialization-failed'
            if (isRecoverableFinalViewWorkerFailure(reason)) {
              rejectBuild(service, lease, 'CONTENT_UNAVAILABLE', 'WORKER_FAILED', input.now, input.retryAfter)
              return { kind: 'source-unavailable', reason }
            }
            rejectBuild(service, lease, 'VIEW_REJECTED', 'FINAL_VIEW_MATERIALIZATION_FAILED', input.now, input.retryAfter)
            return { kind: 'source-unavailable', reason }
          }
        } else if (!input.blobs.readVerified) {
          rejectBuild(service, lease, 'CONTENT_UNAVAILABLE', 'PROJECTION_OUTPUT_READER_UNAVAILABLE', input.now, input.retryAfter)
          return { kind: 'source-unavailable', reason: 'projection-output-reader-unavailable' }
        } else {
          try {
            const materializedMessages = await materializeProjectionOutputManifest(output, identity, input.blobs as ProjectionOutputBlobReader)
            payload = JSON.stringify({ formatVersion: 1, scopeKey: lease.scopeKey, specVersion: input.specVersion,
              sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration, sourceIdentityJson: lease.sourceIdentityJson,
              historyWatermarkJson, messages: materializedMessages })
            payloadByteLength = new TextEncoder().encode(payload).byteLength
            payloadDigest = await projectionPayloadDigest(payload)
          } catch (error) {
            rejectBuild(service, lease, 'VIEW_REJECTED', 'FINAL_VIEW_MATERIALIZATION_FAILED', input.now, input.retryAfter)
            return { kind: 'source-unavailable', reason: error instanceof Error ? error.message : 'final-view-materialization-failed' }
          }
        }
      } else {
        payload = JSON.stringify({ formatVersion: 1, scopeKey: lease.scopeKey, specVersion: input.specVersion,
          sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration, sourceIdentityJson: lease.sourceIdentityJson,
          historyWatermarkJson: (JSON.parse(lease.sourceIdentityJson) as { historyWatermark?: unknown }).historyWatermark ?? null,
          messages: [] })
        payloadByteLength = new TextEncoder().encode(payload).byteLength
        payloadDigest = await projectionPayloadDigest(payload)
      }
      const inlinePayload = !workerFinalBlob && payloadByteLength <= 256 * 1024 ? payload : undefined
      if (inlinePayload === undefined && output && !workerFinalBlob) {
        if (!input.blobs.readVerified) {
          rejectBuild(service, lease, 'CONTENT_UNAVAILABLE', 'PROJECTION_OUTPUT_ROOT_READER_UNAVAILABLE', input.now, input.retryAfter)
          return { kind: 'source-unavailable', reason: 'projection-output-reader-unavailable' }
        }
        try {
          const rootJson = await input.blobs.readVerified(output)
          if (new TextEncoder().encode(rootJson).byteLength !== output.byteLength || await projectionPayloadDigest(rootJson) !== output.payloadDigest) {
            throw new Error('PROJECTION_OUTPUT_ROOT_VERIFICATION_FAILED')
          }
        } catch (error) {
          rejectBuild(service, lease, 'VIEW_REJECTED', 'FINAL_VIEW_ROOT_RETAIN_FAILED', input.now, input.retryAfter)
          return { kind: 'source-unavailable', reason: error instanceof Error ? error.message : 'final-view-root-retain-failed' }
        }
      }
      let finalBlob: Awaited<ReturnType<ProjectionBuildBlobPort['write']>> | undefined
      if (inlinePayload === undefined) {
        try { finalBlob = workerFinalBlob ?? await input.blobs.write(payload) }
        catch (error) {
          rejectBuild(service, lease, 'VIEW_REJECTED', 'FINAL_VIEW_BLOB_WRITE_FAILED', input.now, input.retryAfter)
          return { kind: 'blob-write-failed', reason: error instanceof Error ? error.message : 'final-view-blob-write-failed' }
        }
      }
      if (finalBlob && (finalBlob.byteLength !== payloadByteLength || finalBlob.payloadDigest !== payloadDigest || !finalBlob.locator.trim())) {
        await releaseBlob(finalBlob)
        rejectBuild(service, lease, 'VIEW_REJECTED', 'FINAL_VIEW_BLOB_VERIFICATION_FAILED', input.now, input.retryAfter)
        return { kind: 'blob-write-failed', reason: 'final-view-blob-verification-failed' }
      }
      const validatedRangeJson = JSON.stringify({ formatVersion: 1, specVersion: input.specVersion,
        sourceIdentityJson: lease.sourceIdentityJson, fromSequence: 0, nextSequence: checkpoint.nextSequence,
        payloadDigest, blobByteLength: payloadByteLength })
      try {
        const state = service.publish(lease, { sourceIdentityJson: lease.sourceIdentityJson,
          payloadGeneration: `projection-${payloadDigest}`, payloadDigest, validatedRangeJson,
          ...(finalBlob ? { blobLocator: finalBlob.locator, blobByteLength: finalBlob.byteLength } : { inlinePayload: inlinePayload! }) })
        const reconciled = state ?? service.get(lease.sessionId, lease.scopeKey)
        if (reconciled?.status === 'valid' && reconciled.sourceIdentityJson === lease.sourceIdentityJson &&
          reconciled.payloadDigest === payloadDigest && reconciled.payloadGeneration === `projection-${payloadDigest}` &&
          reconciled.validatedRangeJson === validatedRangeJson) return { kind: 'published', checkpoint, state: reconciled }
        return { kind: 'lease-lost' }
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'TransactionCommitUnknownError') throw error
        const reconciled = service.get(lease.sessionId, lease.scopeKey)
        if (reconciled?.status === 'valid' && reconciled.sourceIdentityJson === lease.sourceIdentityJson &&
          reconciled.payloadDigest === payloadDigest && reconciled.payloadGeneration === `projection-${payloadDigest}` &&
          reconciled.validatedRangeJson === validatedRangeJson) return { kind: 'published', checkpoint, state: reconciled }
        return { kind: 'publish-unknown', checkpoint }
      } finally {
        if (finalBlob) await releaseBlob(finalBlob)
      }
    }
    if (result.kind !== 'chunk') {
      rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'WORKER_RESULT_INVALID', input.now, input.retryAfter)
      return { kind: 'source-unavailable', reason: 'unknown-worker-result' }
    }
    const chunkRowCount = pendingChunk?.rowCount ?? result.events.length
    if (result.afterSessionSequence !== checkpoint.nextSequence || chunkRowCount === 0 ||
      chunkRowCount > limits.maxRows || result.nextSessionSequence <= result.afterSessionSequence ||
      (!pendingChunk && result.byteLength > limits.maxBytes - 128) ||
      (pendingChunk && (result.events.length !== 0 || result.messageFacts.length !== 0 ||
        result.nextSessionSequence !== pendingChunk.nextSequence || result.afterSessionSequence !== pendingChunk.fromSequence)) ||
      (!pendingChunk && (result.events.length !== chunkRowCount || result.events.at(-1)?.sessionSequence !== result.nextSessionSequence))) {
      rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'WORKER_CHUNK_SHAPE_INVALID', input.now, input.retryAfter)
      return { kind: 'chunk-invalid', reason: 'worker-chunk-shape-invalid' }
    }
    if (!pendingChunk && result.events.some((event, eventIndex) =>
      event.sessionSequence !== result.afterSessionSequence + eventIndex + 1)) {
      rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'WORKER_CHUNK_CONTENT_INVALID', input.now, input.retryAfter)
      return { kind: 'chunk-invalid', reason: 'worker-chunk-content-invalid' }
    }
    if (!reducerStateJson && !checkpoint.historyReducerStateBlob) {
      return invalidateInvalidCheckpoint()
    }
    const currentReducerStateJson = reducerStateJson ?? ''
    let folded: ProjectionHistoryChunkReduction
    let promotedReducerArtifacts: Readonly<{
      outputManifests: readonly Awaited<ReturnType<ProjectionBuildBlobPort['write']>>[]
      stableIdIndex: Awaited<ReturnType<ProjectionBuildBlobPort['write']>>
      reducerState?: Awaited<ReturnType<ProjectionBuildBlobPort['write']>>
    }> | undefined
    try {
      let stagedChunkInput: Readonly<{ root: string; manifest: ProjectionPendingHistoryChunkManifestRef }> | undefined
      let reducerEvents = result.events
      let reducerMessageFacts = result.messageFacts
      if (pendingChunk) {
        if (input.reduceChunk && input.blobs.root) stagedChunkInput = { root: input.blobs.root, manifest: pendingChunk }
        else if (input.blobs.readVerified) {
          const payload = JSON.parse(await input.blobs.readVerified(pendingChunk)) as { events?: unknown; messageFacts?: unknown }
          if (!Array.isArray(payload.events) || !Array.isArray(payload.messageFacts)) throw new Error('PROJECTION_PENDING_CHUNK_INVALID')
          reducerEvents = payload.events as ProjectionHistoryChunkEvent[]
          reducerMessageFacts = payload.messageFacts as ProjectionMessageFact[]
        } else throw new Error('PROJECTION_PENDING_CHUNK_READER_UNAVAILABLE')
      }
      if (input.reduceChunk && input.blobs.withWorkerStaging && input.blobs.root) {
        folded = await input.blobs.withWorkerStaging(async (promote, stage) => {
          const allocated = stage.allocate(MAX_STAGED_OUTPUT_MANIFEST_SEGMENTS + 2)
          const outputManifestTempLocators = allocated.slice(0, MAX_STAGED_OUTPUT_MANIFEST_SEGMENTS)
          const stableIdIndexTempLocator = allocated[MAX_STAGED_OUTPUT_MANIFEST_SEGMENTS]
          const reducerStateTempLocator = allocated[MAX_STAGED_OUTPUT_MANIFEST_SEGMENTS + 1]
          const reduction = await input.reduceChunk!(currentReducerStateJson, reducerEvents, reducerMessageFacts, lease.scopeKey,
            !result.hasMore, input.signal, stagedChunkInput, { root: stage.root, outputManifestTempLocators,
              stableIdIndexTempLocator: stableIdIndexTempLocator!, reducerStateTempLocator: reducerStateTempLocator!, context: {
                sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration, scopeKey: lease.scopeKey,
                specVersion: input.specVersion, sourceIdentityJson: lease.sourceIdentityJson,
                parentOutputManifest: checkpoint.outputManifest, priorStableIdIndex: checkpoint.stableIdIndexManifest,
                priorReducerState: checkpoint.historyReducerStateBlob,
              } })
          if (!('stagedArtifacts' in reduction)) return reduction
          const artifacts = reduction.stagedArtifacts
          const promotedOutputs: Awaited<ReturnType<typeof promote>>[] = []
          let promotedStable: Awaited<ReturnType<typeof promote>> | undefined
          let promotedState: Awaited<ReturnType<typeof promote>> | undefined
          try {
            for (const artifact of artifacts.outputManifests) {
              promotedOutputs.push(await promote({ ...artifact, locator: artifact.locator }))
            }
            promotedStable = await promote({ ...artifacts.stableIdIndex, locator: artifacts.stableIdIndex.locator })
            if (artifacts.reducerState) promotedState = await promote({ ...artifacts.reducerState, locator: artifacts.reducerState.locator })
          } catch (error) {
            await releaseBlobs([...promotedOutputs, ...(promotedStable ? [promotedStable] : []), ...(promotedState ? [promotedState] : [])])
            throw error
          }
          promotedReducerArtifacts = { outputManifests: promotedOutputs, stableIdIndex: promotedStable!,
            ...(promotedState ? { reducerState: promotedState } : {}) }
          return reduction
        })
      } else {
        folded = input.reduceChunk
          ? await input.reduceChunk(currentReducerStateJson, reducerEvents, reducerMessageFacts, lease.scopeKey, !result.hasMore, input.signal, stagedChunkInput)
          : input.historyReducer.fold(currentReducerStateJson, reducerEvents, reducerMessageFacts, lease.scopeKey)
      }
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && /WORKER_ABORTED$/.test(error.message))) {
        return { kind: 'checkpointed', checkpoint }
      }
      const reason = error instanceof Error ? error.message : 'history-reducer-rejected-chunk'
      if (reason === 'PROJECTION_REDUCER_OUTPUT_SEGMENT_LIMIT_EXCEEDED') {
        rejectBuild(service, lease, 'CONTENT_UNAVAILABLE', 'DEFERRED_LARGE', input.now, input.retryAfter,
          { eventSequence: result.nextSessionSequence })
        return { kind: 'deferred-large', eventSequence: result.nextSessionSequence }
      }
      if (pendingChunk && /^PROJECTION_PENDING_CHUNK_(?:DIGEST_MISMATCH|SHAPE_INVALID|REFERENCE_INVALID|UNAVAILABLE|INVALID_JSON)$/.test(reason)) {
        return invalidateInvalidCheckpoint()
      }
      if (/^PROJECTION_STABLE_ID_INDEX_INVALID$/.test(reason)) return invalidateInvalidCheckpoint()
      if (/^PROJECTION_REDUCER_STATE_(?:REFERENCE_INVALID|UNAVAILABLE|DIGEST_MISMATCH|INVALID_JSON)$/.test(reason)) {
        return invalidateInvalidCheckpoint()
      }
      if (isRecoverableReducerWorkerFailure(reason)) {
        rejectBuild(service, lease, 'CONTENT_UNAVAILABLE', 'WORKER_FAILED', input.now, input.retryAfter)
        return { kind: 'source-unavailable', reason }
      }
      rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'HISTORY_REDUCER_REJECTED_CHUNK', input.now, input.retryAfter)
      return { kind: 'chunk-invalid', reason }
    }
    if ('stagedArtifacts' in folded) {
      const artifacts = folded.stagedArtifacts
      const promoted = promotedReducerArtifacts
      if (!promoted || promoted.outputManifests.length !== artifacts.outputManifests.length ||
        promoted.outputManifests.some((blob, index) => blob.locator !== artifacts.outputManifests[index]?.locator ||
          blob.byteLength !== artifacts.outputManifests[index]?.byteLength || blob.payloadDigest !== artifacts.outputManifests[index]?.payloadDigest) ||
        promoted.stableIdIndex.byteLength !== artifacts.stableIdIndex.byteLength ||
        promoted.stableIdIndex.payloadDigest !== artifacts.stableIdIndex.payloadDigest ||
        (artifacts.reducerState && (!promoted.reducerState || promoted.reducerState.byteLength !== artifacts.reducerState.byteLength ||
          promoted.reducerState.payloadDigest !== artifacts.reducerState.payloadDigest)) ||
        promoted.outputManifests.length < 1 || promoted.outputManifests.length > MAX_STAGED_OUTPUT_MANIFEST_SEGMENTS ||
        promoted.outputManifests.some((blob) => blob.byteLength < 1 || blob.byteLength > MAX_DERIVED_CHUNK_BLOB_BYTES) ||
        promoted.stableIdIndex.byteLength < 1 || promoted.stableIdIndex.byteLength > MAX_DERIVED_CHUNK_BLOB_BYTES ||
        (promoted.reducerState !== undefined && (promoted.reducerState.byteLength < 1 ||
          promoted.reducerState.byteLength > MAX_DERIVED_CHUNK_BLOB_BYTES))) {
        await releaseBlobs([...(promoted?.outputManifests ?? []), ...(promoted ? [promoted.stableIdIndex] : []),
          ...(promoted?.reducerState ? [promoted.reducerState] : [])])
        rejectBuild(service, lease, 'VIEW_REJECTED', 'STAGED_REDUCER_OUTPUT_INVALID', input.now, input.retryAfter)
        return { kind: 'blob-write-failed', reason: 'staged-reducer-output-invalid' }
      }
      try {
        if (folded.stateJson !== undefined && (!isJsonString(folded.stateJson) || Buffer.byteLength(folded.stateJson) > 64 * 1024)) {
          rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'HISTORY_REDUCER_OUTPUT_INVALID', input.now, input.retryAfter)
          return { kind: 'chunk-invalid', reason: 'history-reducer-output-invalid' }
        }
        const stableIdIndexManifest = { locator: promoted.stableIdIndex.locator,
          byteLength: promoted.stableIdIndex.byteLength, payloadDigest: promoted.stableIdIndex.payloadDigest,
          itemCount: artifacts.stableIdIndex.itemCount, sessionId: lease.sessionId, scopeKey: lease.scopeKey,
          sourceIdentityJson: lease.sourceIdentityJson }
        const stateRef: ProjectionBuildReducerStateManifestRef | null = promoted.reducerState ? {
          locator: promoted.reducerState.locator, byteLength: promoted.reducerState.byteLength,
          payloadDigest: promoted.reducerState.payloadDigest, sessionId: lease.sessionId, scopeKey: lease.scopeKey,
          sourceIdentityJson: lease.sourceIdentityJson,
        } : null
        const receipt: ProjectionBuildChunkReceipt = { sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration,
          scopeKey: lease.scopeKey, specVersion: input.specVersion, sourceIdentityJson: lease.sourceIdentityJson,
          processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken,
          fromSequence: result.afterSessionSequence, nextSequence: result.nextSessionSequence,
          rowCount: chunkRowCount, byteLength: result.byteLength,
          payloadDigest: promoted.outputManifests.at(-1)!.payloadDigest,
          blobLocator: promoted.outputManifests.at(-1)!.locator }
        const advancedBase = acceptProjectionBuildChunk(checkpoint, receipt, limits, folded.stateJson ?? null,
          stableIdIndexManifest, promoted.outputManifests.at(-1)!.byteLength, stateRef, pendingChunk !== null)
        const advanced = advancedBase ? attachProjectionStableIdIndexManifest(advancedBase, stableIdIndexManifest) : advancedBase
        if (!advanced) {
          rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'CHECKPOINT_REDUCER_REJECTED_CHUNK', input.now, input.retryAfter)
          return { kind: 'chunk-invalid', reason: 'checkpoint-reducer-rejected-chunk' }
        }
        if (!service.saveCheckpoint(lease, JSON.stringify(advanced))) return { kind: 'lease-lost' }
        checkpoint = advanced
        if (folded.stateJson === undefined) return { kind: 'checkpointed', checkpoint }
        reducerStateJson = folded.stateJson
      } catch (error) {
        rejectBuild(service, lease, 'VIEW_REJECTED', 'STAGED_REDUCER_CHECKPOINT_FAILED', input.now, input.retryAfter)
        return { kind: 'blob-write-failed', reason: error instanceof Error ? error.message : 'staged-reducer-checkpoint-failed' }
      } finally {
        await releaseBlobs([...promoted.outputManifests, promoted.stableIdIndex, ...(promoted.reducerState ? [promoted.reducerState] : [])])
      }
      continue
    }
    let outputOperations = [...folded.outputOperations]
    if (!result.hasMore) {
      try {
        outputOperations.push(...(folded.finalizedOutputOperations ?? input.historyReducer.finalize(folded.stateJson, lease.scopeKey).outputOperations))
      }
      catch (error) {
        rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'HISTORY_REDUCER_FINALIZE_FAILED', input.now, input.retryAfter)
        return { kind: 'chunk-invalid', reason: error instanceof Error ? error.message : 'history-reducer-finalize-failed' }
      }
    }
    const nextReducerStateJson = folded.stateJson
    const nextReducerStateByteLength = Buffer.byteLength(nextReducerStateJson)
    const externalizeReducerState = nextReducerStateByteLength > 64 * 1024
    try {
      JSON.parse(nextReducerStateJson)
      if (typeof JSON.stringify(outputOperations) !== 'string') throw new Error('non-json reducer output')
    }
    catch {
      rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'HISTORY_REDUCER_OUTPUT_INVALID', input.now, input.retryAfter)
      return { kind: 'chunk-invalid', reason: 'history-reducer-output-invalid' }
    }
    const parentOutputManifest = folded.resetOutput ? null : checkpoint.outputManifest
    const payload = JSON.stringify({ formatVersion: 2, sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration,
      scopeKey: lease.scopeKey, specVersion: input.specVersion, sourceIdentityJson: lease.sourceIdentityJson,
      outputManifest: { formatVersion: 1, parent: parentOutputManifest, operations: outputOperations },
      sourceComplete: !result.hasMore })
    let staged: Awaited<ReturnType<ProjectionBuildBlobPort['write']>>[] = []
    let stableIndex: Readonly<{ payload: string; itemCount: number }> | undefined
    let reducerStateBlob: ProjectionBuildReducerStateManifestRef | null = null
    try {
      if (input.blobs.writeMany) {
        stableIndex = await stableIdIndexPayload({ checkpoint, operations: outputOperations, blobs: input.blobs })
        const payloads = [payload, stableIndex.payload, ...(externalizeReducerState ? [nextReducerStateJson] : [])]
        staged = [...await input.blobs.writeMany(payloads)]
        if (staged.length !== payloads.length) throw new Error('PROJECTION_BLOB_BATCH_INCOMPLETE')
      } else {
        staged = [await input.blobs.write(payload)]
        if (externalizeReducerState) staged.push(await input.blobs.write(nextReducerStateJson))
      }
    }
    catch (error) {
      await releaseBlobs(staged)
      rejectBuild(service, lease, 'VIEW_REJECTED', 'DERIVED_BLOB_WRITE_FAILED', input.now, input.retryAfter)
      return { kind: 'blob-write-failed', reason: error instanceof Error ? error.message : 'blob-write-failed' }
    }
    const [blob, stableIndexBlob, reducerStateStagedBlob] = staged
    try {
      const expectedDigest = await projectionPayloadDigest(payload)
      if (blob.byteLength > MAX_DERIVED_CHUNK_BLOB_BYTES || blob.byteLength < 1 || blob.payloadDigest !== expectedDigest || !blob.locator.trim()) {
        rejectBuild(service, lease, 'VIEW_REJECTED', 'DERIVED_BLOB_VERIFICATION_FAILED', input.now, input.retryAfter)
        return { kind: 'blob-write-failed', reason: 'blob-verification-failed' }
      }
      const receipt: ProjectionBuildChunkReceipt = {
        sessionId: lease.sessionId, sessionGeneration: lease.sessionGeneration, scopeKey: lease.scopeKey,
        specVersion: input.specVersion, sourceIdentityJson: lease.sourceIdentityJson,
        processGeneration: lease.processGeneration, rebuildToken: lease.rebuildToken,
        fromSequence: result.afterSessionSequence, nextSequence: result.nextSessionSequence,
        rowCount: chunkRowCount, byteLength: result.byteLength, payloadDigest: blob.payloadDigest, blobLocator: blob.locator,
      }
      let stableIdIndexManifest = checkpoint.stableIdIndexManifest
      if (stableIndex && stableIndexBlob) {
        const stableDigest = await projectionPayloadDigest(stableIndex.payload)
        if (stableIndexBlob.byteLength !== new TextEncoder().encode(stableIndex.payload).byteLength ||
          stableIndexBlob.payloadDigest !== stableDigest || !stableIndexBlob.locator.trim()) {
          rejectBuild(service, lease, 'VIEW_REJECTED', 'STABLE_ID_INDEX_BLOB_VERIFICATION_FAILED', input.now, input.retryAfter)
          return { kind: 'blob-write-failed', reason: 'stable-id-index-blob-verification-failed' }
        }
        stableIdIndexManifest = { locator: stableIndexBlob.locator, byteLength: stableIndexBlob.byteLength,
          payloadDigest: stableDigest, itemCount: stableIndex.itemCount, sessionId: lease.sessionId,
          scopeKey: lease.scopeKey, sourceIdentityJson: lease.sourceIdentityJson }
      }
      if (externalizeReducerState) {
        const stateBlob = input.blobs.writeMany ? reducerStateStagedBlob : staged[1]
        if (!stateBlob || stateBlob.byteLength !== nextReducerStateByteLength ||
          stateBlob.payloadDigest !== await projectionPayloadDigest(nextReducerStateJson) || !stateBlob.locator.trim()) {
          rejectBuild(service, lease, 'VIEW_REJECTED', 'REDUCER_STATE_BLOB_VERIFICATION_FAILED', input.now, input.retryAfter)
          return { kind: 'blob-write-failed', reason: 'reducer-state-blob-verification-failed' }
        }
        reducerStateBlob = { locator: stateBlob.locator, byteLength: stateBlob.byteLength, payloadDigest: stateBlob.payloadDigest,
          sessionId: lease.sessionId, scopeKey: lease.scopeKey, sourceIdentityJson: lease.sourceIdentityJson }
      }
      const advancedBase = acceptProjectionBuildChunk(checkpoint, receipt, limits,
        externalizeReducerState ? null : nextReducerStateJson, stableIdIndexManifest, blob.byteLength, reducerStateBlob,
        pendingChunk !== null)
      const advanced = advancedBase && stableIdIndexManifest
        ? attachProjectionStableIdIndexManifest(advancedBase, stableIdIndexManifest) : advancedBase
      if (!advanced) {
        rejectBuild(service, lease, 'SPEC_UNSUPPORTED', 'CHECKPOINT_REDUCER_REJECTED_CHUNK', input.now, input.retryAfter)
        return { kind: 'chunk-invalid', reason: 'checkpoint-reducer-rejected-chunk' }
      }
      if (!service.saveCheckpoint(lease, JSON.stringify(advanced))) return { kind: 'lease-lost' }
      checkpoint = advanced
      reducerStateJson = nextReducerStateJson
    } finally {
      await releaseBlobs(staged)
    }
  }
  return { kind: 'checkpointed', checkpoint }
}

/** Temporary blob cleanup is best-effort; it must never replace the durable CAS outcome. */
async function releaseBlob(blob: Readonly<{ release(): Promise<void> }>): Promise<void> {
  try { await blob.release() } catch { /* Unreferenced staging is reclaimed by blob maintenance. */ }
}

async function releaseBlobs(blobs: readonly Readonly<{ release(): Promise<void> }>[]): Promise<void> {
  await Promise.all(blobs.map(releaseBlob))
}

function isDefined<T>(value: T | undefined): value is T { return value !== undefined }

function samePermit(left: ProjectionHistoryChunkPermit, right: ProjectionHistoryChunkPermit): boolean {
  return left.dbPath === right.dbPath && left.sessionId === right.sessionId && left.sessionGeneration === right.sessionGeneration &&
    left.scopeKey === right.scopeKey && left.specVersion === right.specVersion && left.sourceIdentityJson === right.sourceIdentityJson &&
    left.connectionEpoch === right.connectionEpoch && left.processGeneration === right.processGeneration && left.rebuildToken === right.rebuildToken
}

async function stableIdIndexPayload(input: Readonly<{ checkpoint: ProjectionBuildCheckpoint; operations: readonly unknown[]; blobs: ProjectionBuildBlobPort }>): Promise<Readonly<{ payload: string; itemCount: number }>> {
  const { checkpoint, operations, blobs } = input
  let entries: Array<{ id: string; role: string }> = []
  if (checkpoint.stableIdIndexManifest) {
    if (!blobs.readVerified) throw new Error('PROJECTION_STABLE_ID_INDEX_READER_UNAVAILABLE')
    const prior = JSON.parse(await blobs.readVerified(checkpoint.stableIdIndexManifest)) as {
      formatVersion?: unknown; messageCount?: unknown; sessionId?: unknown; scopeKey?: unknown; sourceIdentityJson?: unknown; ids?: unknown; entries?: unknown
    }
    if (prior.formatVersion !== 1 || prior.messageCount !== checkpoint.stableIdIndexManifest.itemCount ||
      prior.sessionId !== checkpoint.sessionId || prior.scopeKey !== checkpoint.scopeKey ||
      prior.sourceIdentityJson !== checkpoint.sourceIdentityJson || !Array.isArray(prior.ids) || !Array.isArray(prior.entries) ||
      prior.entries.length !== checkpoint.stableIdIndexManifest.itemCount || prior.ids.length !== prior.entries.length ||
      new Set(prior.ids).size !== prior.ids.length || prior.entries.some((entry, ordinal) =>
        !entry || typeof entry !== 'object' || (entry as { id?: unknown }).id !== (prior.ids as unknown[])[ordinal] ||
        typeof (entry as { role?: unknown }).role !== 'string' || !(entry as { role: string }).role.trim() ||
        (entry as { ordinal?: unknown }).ordinal !== ordinal)) {
      throw new Error('PROJECTION_STABLE_ID_INDEX_INVALID')
    }
    entries = prior.entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { role?: unknown }).role !== 'string') throw new Error('PROJECTION_STABLE_ID_INDEX_INVALID')
      return { id: (entry as { id: string }).id, role: (entry as { role: string }).role }
    })
  }
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
    const operation = raw as { type?: unknown; messages?: unknown; updates?: unknown }
    if (operation.type === 'appendText') {
      if (!Array.isArray(operation.updates)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
      for (const rawUpdate of operation.updates) {
        if (!rawUpdate || typeof rawUpdate !== 'object' || Array.isArray(rawUpdate)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
        const update = rawUpdate as { id?: unknown; role?: unknown; text?: unknown }
        if (typeof update.id !== 'string' || !update.id.trim() || update.role !== 'assistant' || typeof update.text !== 'string') {
          throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
        }
        const existing = entries.find((entry) => entry.id === update.id)
        if (!existing || existing.role !== update.role) throw new Error('PROJECTION_STABLE_ID_TEXT_APPEND_TARGET_INVALID')
      }
      continue
    }
    if ((operation.type !== 'append' && operation.type !== 'replace') || !Array.isArray(operation.messages)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_OPERATION_INVALID')
    if (operation.type === 'replace') entries = []
    for (const message of operation.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('PROJECTION_STABLE_ID_OUTPUT_MESSAGE_INVALID')
      const candidate = message as { id?: unknown; role?: unknown }
      if (candidate.id === undefined || candidate.id === null) continue
      if (typeof candidate.id !== 'string' || !candidate.id.trim() || typeof candidate.role !== 'string' || !candidate.role.trim()) {
        throw new Error('PROJECTION_STABLE_ID_OUTPUT_IDENTITY_INVALID')
      }
      const existing = entries.findIndex((entry) => entry.id === candidate.id)
      if (existing >= 0) {
        if (entries[existing]!.role !== candidate.role) throw new Error('PROJECTION_STABLE_ID_ROLE_CHANGED')
      } else entries.push({ id: candidate.id, role: candidate.role })
    }
  }
  const payload = JSON.stringify({ formatVersion: 1, messageCount: entries.length,
    sessionId: checkpoint.sessionId, scopeKey: checkpoint.scopeKey,
    sourceIdentityJson: checkpoint.sourceIdentityJson, ids: entries.map((entry) => entry.id),
    entries: entries.map((entry, ordinal) => ({ ...entry, ordinal })) })
  return Object.freeze({ payload, itemCount: entries.length })
}

function rejectBuild(
  service: SessionProjectionService,
  lease: ProjectionRebuildLease,
  code: string,
  caseId: string,
  now: () => number,
  retryAfter: (() => number) | undefined,
  details?: Readonly<Record<string, number>>
): void {
  const current = service.get(lease.sessionId, lease.scopeKey)
  service.reject(lease, { failureCaseJson: JSON.stringify({ case: code, caseId, ...(details ?? {}) }),
    attempts: (current?.attempts ?? 0) + 1,
    retryAfter: code === 'SPEC_UNSUPPORTED' || caseId === 'DEFERRED_LARGE'
      ? Number.MAX_SAFE_INTEGER : retryAfter?.() ?? now() + DEFAULT_PROJECTION_RETRY_DELAY_MS, })
}

function isRecoverableReducerWorkerFailure(reason: string): boolean {
  return /^PROJECTION_REDUCER_WORKER_(?:ENTRY_UNAVAILABLE|SPAWN_FAILED|TIMEOUT|TERMINATION_FAILED|ABORT_FAILED|EXIT(?::|$)|PROTOCOL_MISMATCH|RESULT_INVALID|POST_FAILED|RUNTIME_FAILED|ARTIFACT_IO)(?:$|:)/.test(reason)
}

function isRecoverableFinalViewWorkerFailure(reason: string): boolean {
  return /^PROJECTION_FINAL_VIEW_WORKER_(?:ENTRY_UNAVAILABLE|SPAWN_FAILED|TIMEOUT|TERMINATION_FAILED|ABORT_FAILED|EXIT(?::|$)|PROTOCOL_MISMATCH|RESULT_INVALID|POST_FAILED|RUNTIME_FAILED)(?:$|:)/.test(reason)
}

function isJsonString(value: string): boolean {
  try { JSON.parse(value); return true } catch { return false }
}
