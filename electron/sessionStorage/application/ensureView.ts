export type EnsureViewRead<T> = Readonly<{ ready: true; value: T }> | Readonly<{ ready: false }>

export type EnsureViewInput<T> = Readonly<{
  sessionId: string
  scopeKey: string
  signal?: AbortSignal
  /** Must perform the entire synchronous query inside one fresh source snapshot. */
  read(): EnsureViewRead<T> | Promise<EnsureViewRead<T>>
  /** Schedules or joins preparation for this exact durable scope. Shared work is not owned by a caller's signal. */
  prepare(input: Readonly<{ sessionId: string; scopeKey: string }>): Promise<void>
}>

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('PROJECTION_VIEW_CANCELLED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('PROJECTION_VIEW_CANCELLED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** Per-application coordinator: coalesces preparation by durable scope while keeping each caller's cancellation local. */
export function createEnsureView() {
  const preparing = new Map<string, Promise<void>>()
  return async function ensureView<T>(input: EnsureViewInput<T>): Promise<T> {
    const first = await input.read()
    if (first.ready) return first.value
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('PROJECTION_VIEW_CANCELLED')
    const key = JSON.stringify([input.sessionId, input.scopeKey])
    let shared = preparing.get(key)
    if (!shared) {
      shared = Promise.resolve().then(() => input.prepare({ sessionId: input.sessionId, scopeKey: input.scopeKey }))
      preparing.set(key, shared)
      void shared.finally(() => { if (preparing.get(key) === shared) preparing.delete(key) }).catch(() => undefined)
    }
    await waitForCaller(shared, input.signal)
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('PROJECTION_VIEW_CANCELLED')
    const refreshed = await input.read()
    if (!refreshed.ready) throw new Error('PROJECTION_VIEW_NOT_READY')
    return refreshed.value
  }
}
