import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import type { ProjectionOutputIdentity } from '../../application/projectionOutputManifest'
import type { ProjectionBuildOutputManifestRef } from '../../domain/projectionBuild'

export type ProjectionFinalViewPayload = Readonly<{
  payload?: string
  stagedBlob?: Readonly<{ tempLocator: string; byteLength: number; payloadDigest: string }>
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

export function materializeProjectionFinalViewInWorker(input: Readonly<{
  root: string
  output: ProjectionBuildOutputManifestRef
  identity: ProjectionOutputIdentity
  historyWatermarkJson: unknown
}>): Promise<ProjectionFinalViewPayload> {
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
    const timer = setTimeout(() => { void worker.terminate(); finish(new Error('PROJECTION_FINAL_VIEW_WORKER_TIMEOUT')) }, MAX_MATERIALIZATION_MS)
    const finish = (error?: Error, result?: ProjectionFinalViewPayload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve(result!)
    }
    worker.once('message', (message: { requestId?: string; error?: string; result?: ProjectionFinalViewPayload }) => {
      if (message.requestId !== requestId) { finish(new Error('PROJECTION_FINAL_VIEW_WORKER_PROTOCOL_MISMATCH')); return }
      const result = message.result
      if (message.error) { finish(new Error(message.error)); return }
      if (!result || !Number.isSafeInteger(result.byteLength) || result.byteLength < 0 || !/^[a-f0-9]{64}$/.test(result.payloadDigest) ||
        (typeof result.payload === 'string' && (result.payload.length === 0 || result.byteLength !== Buffer.byteLength(result.payload) || result.stagedBlob !== undefined)) ||
        (result.payload === undefined && (!result.stagedBlob || !/^\.projection-[0-9a-f-]{36}\.tmp$/.test(result.stagedBlob.tempLocator) ||
          result.stagedBlob.byteLength !== result.byteLength || result.stagedBlob.payloadDigest !== result.payloadDigest)) ||
        !Number.isSafeInteger(result.workerThreadId) || result.workerThreadId <= 0) {
        finish(new Error('PROJECTION_FINAL_VIEW_WORKER_RESULT_INVALID'))
        return
      }
      finish(undefined, result)
    })
    worker.once('error', (error) => finish(error))
    worker.once('exit', (code) => { if (!settled) finish(new Error(`PROJECTION_FINAL_VIEW_WORKER_EXIT:${code}`)) })
    try { worker.postMessage({ requestId, root: input.root, output: input.output, identity: input.identity,
      payloadIdentity: { formatVersion: 1, historyWatermarkJson: input.historyWatermarkJson } }) }
    catch (error) { finish(error instanceof Error ? error : new Error('PROJECTION_FINAL_VIEW_WORKER_POST_FAILED')) }
  })
}
