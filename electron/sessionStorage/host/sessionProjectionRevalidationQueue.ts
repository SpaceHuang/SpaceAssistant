
/**
 * Process-local revalidation queue (P0-③). Kept dependency-free so both the read path
 * (sessionTranscriptProjection) and the revalidator (sessionProjectionRevalidation) can
 * enqueue without import cycles; entries collapse per session until consumed.
 */
type QueuedEntry = Readonly<{ stale: boolean }>

const queues = new WeakMap<object, Map<string, QueuedEntry>>()

function queueFor(db: object): Map<string, QueuedEntry> {
  let queue = queues.get(db)
  if (!queue) {
    queue = new Map()
    queues.set(db, queue)
  }
  return queue
}

/** Register one session for background revalidation; duplicates collapse until consumed. */
export function enqueueSessionProjectionRevalidation(db: object, sessionId: string, options: { stale?: boolean } = {}): void {
  const queue = queueFor(db)
  const existing = queue.get(sessionId)
  queue.set(sessionId, { stale: (existing?.stale ?? false) || options.stale === true })
}

/** Take every queued entry; the caller owns re-running or dropping them. */
export function drainSessionProjectionRevalidationQueue(db: object): Array<{ sessionId: string; stale: boolean }> {
  const queue = queueFor(db)
  const entries = [...queue.entries()].map(([sessionId, entry]) => ({ sessionId, stale: entry.stale }))
  queue.clear()
  return entries
}

/** Count of sessions currently waiting (observability/tests). */
export function listQueuedSessionProjectionRevalidations(db: object): string[] {
  return [...queueFor(db).keys()]
}
