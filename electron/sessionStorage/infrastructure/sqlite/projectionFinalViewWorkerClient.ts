import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { ProjectionOutputIdentity } from '../../application/projectionOutputManifest'
import type { ProjectionBuildOutputManifestRef } from '../../domain/projectionBuild'
import { assertPagedChatBodyManifest, type PagedChatBodyManifest } from './pagedChatBodyStore'

export type ProjectionFinalViewPayload = Readonly<{
  payload?: string
  stagedBlob?: Readonly<{ tempLocator: string; byteLength: number; payloadDigest: string }>
  pagedArtifacts?: Readonly<{
    stagedBlobs: readonly Readonly<{ tempLocator: string; locator: string; byteLength: number; payloadDigest: string;
      kind: 'body-block' | 'sequence-directory' | 'id-directory' | 'body-manifest' }>[]
    blobReferences: readonly Readonly<{ locator: string; byteLength: number; payloadDigest: string;
      kind: 'body-block' | 'sequence-directory' | 'id-directory' | 'body-manifest' }>[]
  }>
  byteLength: number
  payloadDigest: string
  workerThreadId: number
}>
const MAX_MATERIALIZATION_MS = 30_000

function resolveWorkerPath(): string | undefined {
  const compiled = path.join(__dirname, 'projectionFinalViewWorker.js')
  const source = path.join(__dirname, 'projectionFinalViewWorker.ts')
  if (fs.existsSync(compiled)) return compiled
  if (fs.existsSync(source)) return source
  return undefined
}

function spawnSourceWorker(workerPath: string): Worker {
  const anchor = path.join(process.cwd(), 'package.json')
  const requireFromProject = createRequire(anchor)
  const bootstrapPath = path.join(os.tmpdir(), `sa-projection-final-view-${randomUUID()}.cjs`)
  requireFromProject.resolve('tsx/cjs/api')
  fs.writeFileSync(bootstrapPath, `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchor = process.env.SA_PROJECTION_VIEW_ANCHOR
const target = process.env.SA_PROJECTION_VIEW_TARGET
const anchorRequire = createRequire(anchor)
anchorRequire('tsx/cjs/api').register()
anchorRequire('tsx/esm/api').tsImport(pathToFileURL(target).href, pathToFileURL(anchor).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`)
  const worker = new Worker(bootstrapPath, { execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    env: { ...process.env, SA_PROJECTION_VIEW_ANCHOR: anchor, SA_PROJECTION_VIEW_TARGET: workerPath } })
  worker.once('exit', () => fs.rm(bootstrapPath, { force: true }, () => undefined))
  return worker
}

function validPagedArtifactPayload(result: ProjectionFinalViewPayload, root: string): boolean {
  if (result.pagedArtifacts === undefined) return true
  try {
    const manifestBlobs = result.pagedArtifacts.stagedBlobs.filter(({ kind }) => kind === 'body-manifest')
    if ((result.payload === undefined) !== (manifestBlobs.length === 1)) return false
    if (manifestBlobs.length > 1) return false
    const manifestText = result.payload ?? fs.readFileSync(path.join(root, manifestBlobs[0]!.tempLocator), 'utf8')
    if (manifestBlobs.length === 1 && (Buffer.byteLength(manifestText) !== manifestBlobs[0]!.byteLength ||
      createHash('sha256').update(manifestText).digest('hex') !== manifestBlobs[0]!.payloadDigest ||
      manifestBlobs[0]!.byteLength !== result.byteLength || manifestBlobs[0]!.payloadDigest !== result.payloadDigest)) return false
    const manifest = JSON.parse(manifestText) as PagedChatBodyManifest
    assertPagedChatBodyManifest(manifest)
    const references = result.pagedArtifacts.blobReferences.filter(({ kind }) => kind !== 'body-manifest')
    if (manifest.messageCount === 0) return references.length === 0 && result.pagedArtifacts.stagedBlobs.length === manifestBlobs.length
    if (references.length < 3) return false
    const locatorSet = new Set(references.map(({ locator }) => locator))
    const valid = locatorSet.size === references.length && references.length === result.pagedArtifacts.stagedBlobs.length - manifestBlobs.length &&
      references.some(({ locator, kind }) => locator === manifest.sequenceRoot?.locator && kind === 'sequence-directory') &&
      references.some(({ locator, kind }) => locator === manifest.idRoot?.locator && kind === 'id-directory')
    return valid
  } catch { return false }
}

export function materializeProjectionFinalViewInWorker(input: Readonly<{
  root: string
  output: ProjectionBuildOutputManifestRef
  identity: ProjectionOutputIdentity
  historyWatermarkJson: unknown
  signal?: AbortSignal
}>): Promise<ProjectionFinalViewPayload> {
  if (input.signal?.aborted) return Promise.reject(new Error('PROJECTION_FINAL_VIEW_WORKER_ABORTED'))
  const workerPath = resolveWorkerPath()
  if (!workerPath) return Promise.reject(new Error('PROJECTION_FINAL_VIEW_WORKER_ENTRY_UNAVAILABLE'))
  let worker: Worker
  try {
    worker = workerPath.endsWith('.ts') ? spawnSourceWorker(workerPath) : new Worker(workerPath, {
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    })
  } catch (error) {
    return Promise.reject(new Error(`PROJECTION_FINAL_VIEW_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`))
  }
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    let settled = false
    let abortRequested = false
    let candidateError: Error | undefined
    let candidateResult: ProjectionFinalViewPayload | undefined
    const timer = setTimeout(() => {
      candidateError = new Error('PROJECTION_FINAL_VIEW_WORKER_TIMEOUT')
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_FINAL_VIEW_WORKER_TERMINATION_FAILED') })
    }, MAX_MATERIALIZATION_MS)
    const onAbort = () => {
      abortRequested = true
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_FINAL_VIEW_WORKER_ABORT_FAILED') })
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (error?: Error, result?: ProjectionFinalViewPayload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve(result!)
    }
    const stopWithError = (error: Error) => {
      candidateError ??= error
      void worker.terminate().catch(() => { candidateError = new Error('PROJECTION_FINAL_VIEW_WORKER_TERMINATION_FAILED') })
    }
    worker.once('message', (message: { requestId?: string; error?: string; result?: ProjectionFinalViewPayload }) => {
      if (message.requestId !== requestId) { stopWithError(new Error('PROJECTION_FINAL_VIEW_WORKER_PROTOCOL_MISMATCH')); return }
      const result = message.result
      if (message.error) { stopWithError(new Error(message.error)); return }
      if (!result || !Number.isSafeInteger(result.byteLength) || result.byteLength < 0 || !/^[a-f0-9]{64}$/.test(result.payloadDigest) ||
        (typeof result.payload === 'string' && (result.payload.length === 0 || result.byteLength !== Buffer.byteLength(result.payload) || result.stagedBlob !== undefined)) ||
        (result.payload === undefined && !result.stagedBlob && !result.pagedArtifacts) ||
        (result.payload === undefined && result.stagedBlob !== undefined && (!/^\.projection-[0-9a-f-]{36}\.tmp$/.test(result.stagedBlob.tempLocator) ||
          result.stagedBlob.byteLength !== result.byteLength || result.stagedBlob.payloadDigest !== result.payloadDigest)) ||
        (result.pagedArtifacts !== undefined && (result.stagedBlob !== undefined ||
          !Array.isArray(result.pagedArtifacts.stagedBlobs) || !Array.isArray(result.pagedArtifacts.blobReferences) ||
          result.pagedArtifacts.stagedBlobs.length > 100_000 ||
          result.pagedArtifacts.stagedBlobs.length !== result.pagedArtifacts.blobReferences.length ||
          result.pagedArtifacts.stagedBlobs.some((blob, index) => !blob ||
            !/^\.projection-[0-9a-f-]{36}\.tmp$/.test(blob.tempLocator) ||
            blob.locator !== `projection-${blob.tempLocator.slice('.projection-'.length, -'.tmp'.length)}.blob` ||
            !Number.isSafeInteger(blob.byteLength) || blob.byteLength < 1 || !/^[a-f0-9]{64}$/.test(blob.payloadDigest) ||
            !['body-block','sequence-directory','id-directory','body-manifest'].includes(blob.kind) ||
            result.pagedArtifacts!.blobReferences[index]?.locator !== blob.locator ||
            result.pagedArtifacts!.blobReferences[index]?.byteLength !== blob.byteLength ||
            result.pagedArtifacts!.blobReferences[index]?.payloadDigest !== blob.payloadDigest ||
            result.pagedArtifacts!.blobReferences[index]?.kind !== blob.kind)) || !validPagedArtifactPayload(result, input.root)) ||
        !Number.isSafeInteger(result.workerThreadId) || result.workerThreadId <= 0) {
        stopWithError(new Error('PROJECTION_FINAL_VIEW_WORKER_RESULT_INVALID'))
        return
      }
      candidateResult = result
    })
    worker.once('error', (error) => { candidateError ??= error })
    worker.once('exit', (code) => { if (!settled) finish(candidateError ?? (abortRequested ? new Error('PROJECTION_FINAL_VIEW_WORKER_ABORTED') :
      candidateResult && code === 0 ? undefined : new Error(`PROJECTION_FINAL_VIEW_WORKER_EXIT:${code}`)), candidateResult) })
    try { worker.postMessage({ requestId, root: input.root, output: input.output, identity: input.identity,
      payloadIdentity: { formatVersion: 1, historyWatermarkJson: input.historyWatermarkJson } }) }
    catch (error) { stopWithError(error instanceof Error ? error : new Error('PROJECTION_FINAL_VIEW_WORKER_POST_FAILED')) }
  })
}
