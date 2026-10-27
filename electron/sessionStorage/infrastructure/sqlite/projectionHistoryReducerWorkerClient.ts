import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { threadId as currentThreadId } from 'node:worker_threads'
import type { ProjectionPendingHistoryChunkManifestRef } from '../../domain/projectionBuild'
import type { ProjectionHistoryChunkReducerPort, ProjectionHistoryChunkReduction, ProjectionReducerArtifactStaging } from '../../application/projectionBuildCoordinator'
import type { ProjectionInvocationBodySources } from './projectionChatBodySourceReducer'
import type { PreparedProjectionSourceArtifactSet, StagedProjectionSourceBlob } from './projectionChatBodySourceReducer'
import type { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'

const MAX_REDUCER_WORKER_MS = 15_000

function resolveWorkerPath(): string | undefined {
  const compiled = path.join(__dirname, 'projectionHistoryReducerWorker.js')
  const source = path.join(__dirname, 'projectionHistoryReducerWorker.ts')
  if (fs.existsSync(compiled)) return compiled
  if (fs.existsSync(source)) return source
  return undefined
}

function spawnSourceWorker(workerPath: string): Worker {
  const anchor = path.join(process.cwd(), 'package.json')
  const requireFromProject = createRequire(anchor)
  const bootstrapPath = path.join(os.tmpdir(), `sa-projection-reducer-${randomUUID()}.cjs`)
  requireFromProject.resolve('tsx/cjs/api')
  fs.writeFileSync(bootstrapPath, `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchor = process.env.SA_PROJECTION_REDUCER_ANCHOR
const target = process.env.SA_PROJECTION_REDUCER_TARGET
const anchorRequire = createRequire(anchor)
anchorRequire('tsx/cjs/api').register()
anchorRequire('tsx/esm/api').tsImport(pathToFileURL(target).href, pathToFileURL(anchor).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`)
  const worker = new Worker(bootstrapPath, {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    env: { ...process.env, SA_PROJECTION_REDUCER_ANCHOR: anchor, SA_PROJECTION_REDUCER_TARGET: workerPath },
  })
  worker.once('exit', () => fs.rm(bootstrapPath, { force: true }, () => undefined))
  return worker
}

type SourceStagingInput = Readonly<{ root: string; tempLocators: readonly string[]; sessionId: string; sessionGeneration: string;
  sourceRevision: number; sourceIdentityJson: string; historyWatermarkJson: string; reducerSpecVersion: number }>
type SourceBlobStore = Pick<ReturnType<typeof createSessionProjectionBlobStore>, 'withWorkerStaging'>
type PreparedSourceBlob = Readonly<{ locator: string; byteLength: number; payloadDigest: string; release(): Promise<void> }>

export async function reduceAndPublishProjectionInvocationChatBodySourcesInWorker<T>(input: Readonly<{
  events: readonly ProjectionHistoryChunkEvent[]
  messageFacts: readonly ProjectionMessageFact[]
  blobs: SourceBlobStore
  context: Omit<SourceStagingInput, 'root' | 'tempLocators'>
  signal?: AbortSignal
  publish(source: ProjectionInvocationBodySources, artifacts?: PreparedProjectionSourceArtifactSet): Promise<T>
}>): Promise<T> {
  return input.blobs.withWorkerStaging(async (promote, stage) => {
    const tempLocators = [stage.tempLocator]
    const segmentedMessageCount = input.events.reduce((count, event) => {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as { kind?: unknown; messageCount?: unknown } : undefined
      return payload?.kind === 'source-segmented-history-event' && Number.isSafeInteger(payload.messageCount)
        ? Math.max(count, payload.messageCount as number) : count
    }, 0)
    for (let remaining = Math.max(input.messageFacts.length, segmentedMessageCount); remaining > 0;) {
      const count = Math.min(32, remaining)
      tempLocators.push(...stage.allocate(count))
      remaining -= count
    }
    const source = await reduceProjectionInvocationChatBodySourcesInWorker(input.events, input.messageFacts, {
      signal: input.signal, staging: { ...input.context, root: stage.root, tempLocators },
    })
    const staged = source.stagedArtifacts
    const { stagedArtifacts: _stagedArtifacts, ...metadata } = source
    if (!staged) return input.publish(metadata)
    const promoted: PreparedSourceBlob[] = []
    try {
      const manifest = await promote(staged.manifest)
      promoted.push(manifest)
      const fragments = new Map<string, PreparedSourceBlob>()
      for (const { messageId, blob } of staged.fragments) {
        if (fragments.has(messageId)) throw new Error('PROJECTION_SOURCE_FRAGMENT_DUPLICATE')
        const promotedBlob = await promote(blob)
        promoted.push(promotedBlob)
        fragments.set(messageId, promotedBlob)
      }
      if (fragments.size !== metadata.messages.length) throw new Error('PROJECTION_SOURCE_FRAGMENT_COVERAGE_MISMATCH')
      return await input.publish(metadata, { manifest, fragmentsByMessage: fragments })
    } finally {
      await promoted[0]?.release()
    }
  })
}

export function reduceProjectionInvocationChatBodySourcesInWorker(events: readonly ProjectionHistoryChunkEvent[],
  messageFacts: readonly ProjectionMessageFact[], options: Readonly<{ signal?: AbortSignal; timeoutMs?: number;
    workerPath?: string; createWorker?: (workerPath: string) => Worker; staging?: SourceStagingInput }> = {}): Promise<ProjectionInvocationBodySources> {
  if (options.signal?.aborted) return Promise.reject(new Error('PROJECTION_REDUCER_WORKER_ABORTED'))
  const workerPath = options.workerPath ?? resolveWorkerPath()
  if (!workerPath) return Promise.reject(new Error('PROJECTION_REDUCER_WORKER_ENTRY_UNAVAILABLE'))
  let worker: Worker
  try { worker = options.createWorker?.(workerPath) ?? (workerPath.endsWith('.ts') ? spawnSourceWorker(workerPath) : new Worker(workerPath, {
    execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
  })) }
  catch (error) { return Promise.reject(new Error(`PROJECTION_REDUCER_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`)) }
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    let settled = false
    let result: ProjectionInvocationBodySources | undefined
    let failure: Error | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result!)
    }
    const stop = (error: Error) => {
      if (failure || settled) return
      failure = error
      void worker.terminate().catch(() => { failure = new Error('PROJECTION_REDUCER_WORKER_TERMINATION_FAILED') })
    }
    const onAbort = () => stop(new Error('PROJECTION_REDUCER_WORKER_ABORTED'))
    const timer = setTimeout(() => stop(new Error('PROJECTION_REDUCER_WORKER_TIMEOUT')), options.timeoutMs ?? MAX_REDUCER_WORKER_MS)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (message: { requestId?: string; error?: string; result?: unknown }) => {
      if (message.requestId !== requestId) { stop(new Error('PROJECTION_REDUCER_WORKER_PROTOCOL_MISMATCH')); return }
      if (message.error) { stop(new Error(message.error)); return }
      const candidate = message.result && typeof message.result === 'object' && 'source' in message.result
        ? { ...(message.result as { source: ProjectionInvocationBodySources }).source,
          stagedArtifacts: (message.result as { stagedArtifacts?: ProjectionInvocationBodySources['stagedArtifacts'] }).stagedArtifacts }
        : message.result
      if (!isProjectionInvocationBodySources(candidate) || candidate.workerThreadId === currentThreadId ||
        (options.staging !== undefined && (!candidate.stagedArtifacts || !isStagedSourceArtifacts(candidate.stagedArtifacts)))) {
        stop(new Error('PROJECTION_SOURCE_REDUCER_WORKER_RESULT_INVALID'))
        return
      }
      result = candidate
    })
    worker.once('error', (error) => { failure ??= new Error(`PROJECTION_REDUCER_WORKER_RUNTIME_FAILED:${error.message}`) })
    worker.once('exit', (code) => finish(failure ?? (result && code === 0 ? undefined : new Error(`PROJECTION_REDUCER_WORKER_EXIT:${code}`))))
    try { worker.postMessage({ requestId, operation: 'source-invocation', events, messageFacts, stateJson: '', scopeKey: '', finalize: true,
      ...(options.staging ? { sourceStaging: options.staging } : {}) }) }
    catch (error) { stop(error instanceof Error ? error : new Error('PROJECTION_REDUCER_WORKER_POST_FAILED')) }
  })
}

function isProjectionInvocationBodySources(value: unknown): value is ProjectionInvocationBodySources {
  if (!value || typeof value !== 'object') return false
  const source = value as Partial<ProjectionInvocationBodySources>
  return typeof source.invocationId === 'string' && Boolean(source.invocationId) && typeof source.replacesPriorMessages === 'boolean' &&
    Array.isArray(source.messages) && source.messages.every((message) => Boolean(message && typeof message.id === 'string' && message.id &&
      (message.role === 'user' || message.role === 'assistant') && (message.content === undefined || typeof message.content === 'string') &&
      Number.isSafeInteger(message.timestamp) && Number.isSafeInteger(message.sequence))) &&
    Array.isArray(source.dependencies) && source.dependencies.length > 0 && source.dependencies.every((dependency) =>
      Boolean(dependency && typeof dependency.eventId === 'string' && Number.isSafeInteger(dependency.sequence) &&
        Number.isSafeInteger(dependency.sessionSequence) && /^[a-f0-9]{64}$/.test(dependency.digest))) &&
    typeof source.dependencyManifestJson === 'string' && /^[a-f0-9]{64}$/.test(source.dependencyManifestDigest ?? '') &&
    source.dependenciesByMessage instanceof Map && source.manifestDigestByMessage instanceof Map &&
    Number.isSafeInteger(source.workerThreadId) && source.workerThreadId! > 0 && Boolean(source.workerSample &&
      isWorkerSample(source.workerSample)) && source.messages.every((message) => source.dependenciesByMessage!.has(message.id) &&
        source.manifestDigestByMessage!.has(message.id))
}

function isStagedSourceArtifacts(value: unknown): value is NonNullable<ProjectionInvocationBodySources['stagedArtifacts']> {
  if (!value || typeof value !== 'object') return false
  const artifacts = value as { manifest?: StagedProjectionSourceBlob; fragments?: readonly { messageId: string; blob: StagedProjectionSourceBlob }[] }
  const valid = (blob: StagedProjectionSourceBlob | undefined) => Boolean(blob &&
    /^\.projection-[0-9a-f-]{36}\.tmp$/.test(blob.tempLocator) &&
    blob.locator === `${blob.tempLocator.slice(1, -4)}.blob` && Number.isSafeInteger(blob.byteLength) && blob.byteLength > 0 &&
    /^[a-f0-9]{64}$/.test(blob.payloadDigest))
  return valid(artifacts.manifest) && Array.isArray(artifacts.fragments) && artifacts.fragments.every((item) =>
    Boolean(item && typeof item.messageId === 'string' && item.messageId && valid(item.blob)))
}

export const reduceProjectionHistoryChunkInWorker: ProjectionHistoryChunkReducerPort =
  (stateJson: string, events: readonly ProjectionHistoryChunkEvent[], messageFacts: readonly ProjectionMessageFact[],
    scopeKey: string, finalize: boolean, signal?: AbortSignal,
    stagedChunk?: Readonly<{ root: string; manifest: ProjectionPendingHistoryChunkManifestRef }>,
    staging?: ProjectionReducerArtifactStaging): Promise<ProjectionHistoryChunkReduction> => {
    if (signal?.aborted) return Promise.reject(new Error('PROJECTION_REDUCER_WORKER_ABORTED'))
    const workerPath = resolveWorkerPath()
    if (!workerPath) return Promise.reject(new Error('PROJECTION_REDUCER_WORKER_ENTRY_UNAVAILABLE'))
    let worker: Worker
    try {
      worker = workerPath.endsWith('.ts') ? spawnSourceWorker(workerPath) : new Worker(workerPath, {
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
      })
    } catch (error) {
      return Promise.reject(new Error(`PROJECTION_REDUCER_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`))
    }
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      let abortRequested = false
    let candidateError: Error | undefined
    let candidateResult: ProjectionHistoryChunkReduction | undefined
      const timer = setTimeout(() => {
        void worker.terminate().then(() => finish(new Error('PROJECTION_REDUCER_WORKER_TIMEOUT')),
          () => finish(new Error('PROJECTION_REDUCER_WORKER_TERMINATION_FAILED')))
      }, MAX_REDUCER_WORKER_MS)
      const onAbort = () => {
        abortRequested = true
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_REDUCER_WORKER_ABORT_FAILED') })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (error?: Error, result?: ProjectionHistoryChunkReduction) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve(result!)
      }
    const stopWithError = (error: Error) => {
      candidateError ??= error
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_REDUCER_WORKER_TERMINATION_FAILED') })
    }
      worker.once('message', (message: { requestId?: string; error?: string; result?: unknown }) => {
      if (message.requestId !== requestId) { stopWithError(new Error('PROJECTION_REDUCER_WORKER_PROTOCOL_MISMATCH')); return }
      if (message.error) { stopWithError(new Error(message.error)); return }
        const result = message.result as ProjectionHistoryChunkReduction | undefined
        const staged = result && 'stagedArtifacts' in result ? result.stagedArtifacts : undefined
        const hasInline = result && 'stateJson' in result && 'outputOperations' in result &&
          typeof result.stateJson === 'string' && Array.isArray(result.outputOperations)
        const hasStaged = staged && Array.isArray(staged.outputManifests) && staged.outputManifests.length > 0 &&
          staged.outputManifests.length <= 14 && staged.outputManifests.every(isStagedArtifact) &&
          isStagedArtifact(staged.stableIdIndex) &&
          Number.isSafeInteger(staged.stableIdIndex.itemCount) && staged.stableIdIndex.itemCount >= 0 &&
          (staged.reducerState === undefined || isStagedArtifact(staged.reducerState)) &&
          new Set([...staged.outputManifests.map((artifact) => artifact.tempLocator), staged.stableIdIndex.tempLocator,
            ...(staged.reducerState ? [staged.reducerState.tempLocator] : [])]).size ===
            staged.outputManifests.length + 1 + (staged.reducerState ? 1 : 0) &&
          result !== undefined && !('outputOperations' in result) && !('finalizedOutputOperations' in result)
        if (!result || (!hasInline && !hasStaged) || typeof result.resetOutput !== 'boolean' && hasStaged ||
          ('finalizedOutputOperations' in result && result.finalizedOutputOperations !== undefined && !Array.isArray(result.finalizedOutputOperations)) ||
          !Number.isSafeInteger(result.workerThreadId) || result.workerThreadId! <= 0 || !isWorkerSample(result.workerSample)) {
          stopWithError(new Error('PROJECTION_REDUCER_WORKER_RESULT_INVALID'))
          return
        }
        candidateResult = result
      })
      worker.once('error', (error) => { candidateError ??= new Error(`PROJECTION_REDUCER_WORKER_RUNTIME_FAILED:${error.message}`) })
      worker.once('exit', (code) => {
        if (!settled) finish(candidateError ?? (abortRequested ? new Error('PROJECTION_REDUCER_WORKER_ABORTED') :
          candidateResult && code === 0 ? undefined : new Error(`PROJECTION_REDUCER_WORKER_EXIT:${code}`)), candidateResult)
      })
      try { worker.postMessage({ requestId, stateJson, events, messageFacts, scopeKey, finalize, stagedChunk, staging }) }
      catch (error) { stopWithError(error instanceof Error ? error : new Error('PROJECTION_REDUCER_WORKER_POST_FAILED')) }
    })
  }

function isStagedArtifact(value: unknown): value is Readonly<{ tempLocator: string; locator: string; byteLength: number; payloadDigest: string }> {
  return Boolean(value && typeof value === 'object' &&
    /^\.projection-[0-9a-f-]{36}\.tmp$/.test((value as { tempLocator?: string }).tempLocator ?? '') &&
    /^projection-[0-9a-f-]{36}\.blob$/.test((value as { locator?: string }).locator ?? '') &&
    (value as { locator?: string }).locator === `${((value as { tempLocator: string }).tempLocator).slice(1, -4)}.blob` &&
    Number.isSafeInteger((value as { byteLength?: number }).byteLength) && (value as { byteLength: number }).byteLength > 0 &&
    /^[a-f0-9]{64}$/.test((value as { payloadDigest?: string }).payloadDigest ?? ''))
}

function isWorkerSample(value: unknown): value is NonNullable<ProjectionHistoryChunkReduction['workerSample']> {
  if (!value || typeof value !== 'object') return false
  const sample = value as Partial<NonNullable<ProjectionHistoryChunkReduction['workerSample']>>
  return Number.isFinite(sample.durationMs) && sample.durationMs! >= 0 &&
    Number.isSafeInteger(sample.heapUsedBytesAtExit) && sample.heapUsedBytesAtExit! >= 0 &&
    Number.isSafeInteger(sample.processRssBytesAtExit) && sample.processRssBytesAtExit! >= 0 &&
    Number.isSafeInteger(sample.heapUsedBytesPeakSampled) && sample.heapUsedBytesPeakSampled! >= sample.heapUsedBytesAtExit! &&
    Number.isSafeInteger(sample.processRssBytesPeakSampled) && sample.processRssBytesPeakSampled! >= sample.processRssBytesAtExit! &&
    sample.memorySampleIntervalMs === 10
}
