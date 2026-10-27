import path from 'node:path'
import { lock as acquireFileLock, type LockOptions } from 'proper-lockfile'

type LocalQueue = { tail: Promise<void>; users: number }
const localQueues = new Map<string, LocalQueue>()

/** Serialize same-process callers before taking the cross-process filesystem fence. */
export default async function acquireProjectionBlobLock(file: string, options: LockOptions): Promise<() => Promise<void>> {
  const lockfile = path.resolve(options.lockfilePath ?? `${path.resolve(file)}.lock`)
  let queue = localQueues.get(lockfile)
  if (!queue) {
    queue = { tail: Promise.resolve(), users: 0 }
    localQueues.set(lockfile, queue)
  }

  queue.users += 1
  const predecessor = queue.tail
  let releaseTurn!: () => void
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve })
  queue.tail = predecessor.then(() => turn)
  await predecessor

  const releaseQueue = () => {
    releaseTurn()
    queue!.users -= 1
    if (queue!.users === 0 && localQueues.get(lockfile) === queue) localQueues.delete(lockfile)
  }
  try {
    const releaseFileLock = await acquireFileLock(file, options)
    let released = false
    return async () => {
      if (released) return
      released = true
      try { await releaseFileLock() } finally { releaseQueue() }
    }
  } catch (error) {
    releaseQueue()
    throw error
  }
}
