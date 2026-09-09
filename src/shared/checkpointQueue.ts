export type CheckpointWriteResult = boolean | void
export type CheckpointWrite = () => CheckpointWriteResult | Promise<CheckpointWriteResult>

/**
 * Per-turn checkpoint writer. Synchronous adapters keep their existing immediate
 * semantics; asynchronous adapters are serialized so one turn never has two
 * persistence writes in flight at once.
 */
export class CheckpointQueue {
  private readonly tails = new Map<string, Promise<void>>()

  enqueue(key: string, write: CheckpointWrite): CheckpointWriteResult | Promise<CheckpointWriteResult> {
    const tail = this.tails.get(key)
    if (!tail) {
      const result = write()
      if (!isPromiseLike(result)) return result
      return this.track(key, Promise.resolve(result))
    }

    return this.track(key, tail.then(() => write()))
  }

  private track(key: string, result: Promise<CheckpointWriteResult>): Promise<CheckpointWriteResult> {
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}

function isPromiseLike(value: unknown): value is Promise<CheckpointWriteResult> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}
