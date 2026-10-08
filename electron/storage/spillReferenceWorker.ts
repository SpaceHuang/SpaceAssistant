import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { iterateSpillDescriptorReferencesStrict, type SpillDescriptor } from './spillProtocol'

export type SpillReferenceWorkerEntry = Readonly<{ path: string; descriptor: SpillDescriptor }>

/** Parse/validate an owner in a dedicated worker and hand the caller bounded descriptor pages. */
export async function visitSpillReferencesOffThread(
  payload: string,
  onChunk: (rows: readonly SpillReferenceWorkerEntry[]) => void,
  options: { signal?: AbortSignal; createWorker?: (workerPath: string) => Worker } = {}
): Promise<number> {
  const { signal } = options
  if (signal?.aborted) throw new Error('spill-reference-maintenance-paused')
  const compiledPath = path.join(__dirname, 'spillReferenceCollectorWorker.js')
  const sourcePath = path.join(__dirname, 'spillReferenceCollectorWorker.ts')
  const workerPath = fs.existsSync(compiledPath) ? compiledPath : sourcePath
  const canRunSourceWorker = process.execArgv.some((argument) => argument.includes('tsx'))
  if (!options.createWorker && (!fs.existsSync(workerPath) || (workerPath.endsWith('.ts') && !canRunSourceWorker))) {
    let page: SpillReferenceWorkerEntry[] = []
    let bytes = 0
    let count = 0
    for (const row of iterateSpillDescriptorReferencesStrict(JSON.parse(payload) as unknown)) {
      if (signal?.aborted) throw new Error('spill-reference-maintenance-paused')
      const rowBytes = Buffer.byteLength(JSON.stringify(row.descriptor), 'utf8')
      if (page.length && (page.length >= 200 || bytes + rowBytes > 512 * 1024)) {
        onChunk(page)
        if (signal?.aborted) throw new Error('spill-reference-maintenance-paused')
        page = []
        bytes = 0
      }
      page.push(row)
      bytes += rowBytes
      count += 1
    }
    if (page.length) onChunk(page)
    if (signal?.aborted) throw new Error('spill-reference-maintenance-paused')
    return count
  }
  const worker = options.createWorker?.(workerPath) ?? new Worker(workerPath)
  const ackBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const ack = new Int32Array(ackBuffer)
  return new Promise<number>((resolve, reject) => {
    let settled = false
    const removeAbortListener = () => signal?.removeEventListener('abort', onAbort)
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      removeAbortListener()
      void worker.terminate()
      reject(error)
    }
    const onAbort = () => fail(new Error('spill-reference-maintenance-paused'))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (message: { type: string; sequence?: number; rows?: SpillReferenceWorkerEntry[]; count?: number; error?: string }) => {
      if (message.type === 'chunk' && message.sequence !== undefined && message.rows) {
        try {
          onChunk(message.rows)
          Atomics.store(ack, 1, message.sequence + 1)
          Atomics.notify(ack, 1)
        } catch (error) {
          Atomics.store(ack, 1, message.sequence + 1)
          Atomics.notify(ack, 1)
          fail(error instanceof Error ? error : new Error('spill-reference-worker-consumer-failed'))
        }
      } else if (message.type === 'complete') {
        settled = true
        removeAbortListener()
        resolve(message.count ?? 0)
        void worker.terminate()
      } else if (message.type === 'error') fail(new Error(message.error ?? 'spill-reference-worker-failed'))
    })
    worker.once('error', (error) => fail(error))
    worker.once('exit', (code) => { if (!settled && code !== 0) fail(new Error(`spill-reference-worker-exit-${code}`)) })
    worker.postMessage({ payload, ackBuffer })
  })
}
