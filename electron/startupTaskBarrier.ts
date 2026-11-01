/** Starts independent startup work immediately and lets its owner await a failure-safe barrier. */
export function createStartupTaskBarrier(
  task: () => unknown | Promise<unknown>,
  onError: (error: unknown) => void
): () => Promise<void> {
  let taskResult: Promise<unknown>
  try {
    taskResult = Promise.resolve(task())
  } catch (error) {
    taskResult = Promise.reject(error)
  }
  const settled = taskResult.then(() => undefined, (error) => {
    try { onError(error) } catch { /* Error reporting must not change startup behavior. */ }
  })
  return async () => { await settled }
}
