import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { waitForSpillReferenceAck, type SpillReferenceAckAtomics } from './spillReferenceWorkerAck'
import { visitSpillReferencesOffThread } from './spillReferenceWorker'

describe('spill reference worker acknowledgement', () => {
  it('waits on the value observed before an acknowledgement races with the wait', () => {
    const ack = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2))
    let firstLoad = true
    let waitExpected: number | undefined
    const atomics: SpillReferenceAckAtomics = {
      load: (array, index) => {
        if (firstLoad) { firstLoad = false; return 0 }
        return Atomics.load(array, index)
      },
      wait: (array, index, expected) => {
        waitExpected = expected
        Atomics.store(array, index, 1)
        Atomics.notify(array, index)
        return Atomics.wait(array, index, expected, 10)
      }
    }
    expect(() => waitForSpillReferenceAck(ack, 1, atomics)).not.toThrow()
    expect(waitExpected).toBe(0)
    expect(Atomics.load(ack, 1)).toBe(1)
  })

  it('honors cancellation at a bounded descriptor chunk in source fallback mode', async () => {
    const controller = new AbortController()
    const payload = JSON.stringify(Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`ref-${index}`, {
      __spaceassistant_spill_v1: { version: 1, kind: 'degradable', locator: `${index.toString(16).padStart(8, '0')}.spill`, byteLength: 1, sha256: 'a'.repeat(64), createdAt: 1, head: '', tail: '' }
    }])))
    await expect(visitSpillReferencesOffThread(payload, () => controller.abort(), { signal: controller.signal })).rejects.toThrow('spill-reference-maintenance-paused')
  })

  it('terminates the worker and settles its visitor when cancelled while the worker is waiting', async () => {
    const controller = new AbortController()
    const worker = Object.assign(new EventEmitter(), {
      postMessage: () => undefined,
      terminate: vi.fn().mockResolvedValue(1)
    }) as unknown as Worker
    const pending = visitSpillReferencesOffThread('{}', () => undefined, { signal: controller.signal, createWorker: () => worker })
    controller.abort()
    await expect(pending).rejects.toThrow('spill-reference-maintenance-paused')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})
