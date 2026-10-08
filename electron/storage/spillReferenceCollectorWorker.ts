import { parentPort } from 'node:worker_threads'
import { iterateSpillDescriptorReferencesStrict } from './spillProtocol'
import { waitForSpillReferenceAck } from './spillReferenceWorkerAck'

if (!parentPort) throw new Error('spill reference collector worker requires a parent port')

parentPort.on('message', ({ payload, ackBuffer }: { payload: string; ackBuffer: SharedArrayBuffer }) => {
  const ack = new Int32Array(ackBuffer)
  let sequence = 0
  let rows: Array<{ path: string; descriptor: unknown }> = []
  let bytes = 0
  const flush = () => {
    if (!rows.length) return
    const current = sequence++
    const batch = rows
    rows = []
    bytes = 0
    Atomics.store(ack, 0, current)
    parentPort!.postMessage({ type: 'chunk', sequence: current, rows: batch })
    waitForSpillReferenceAck(ack, current + 1)
  }
  try {
    let count = 0
    for (const reference of iterateSpillDescriptorReferencesStrict(JSON.parse(payload) as unknown)) {
      const descriptorBytes = Buffer.byteLength(JSON.stringify(reference.descriptor), 'utf8')
      if (rows.length && (rows.length >= 200 || bytes + descriptorBytes > 512 * 1024)) flush()
      rows.push(reference)
      bytes += descriptorBytes
      count += 1
    }
    flush()
    parentPort!.postMessage({ type: 'complete', count })
  } catch (error) {
    parentPort!.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'unknown-spill-parse-error' })
  }
})
