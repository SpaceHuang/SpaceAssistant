export type StartupPhaseReport = {
  phase: string
  durationMs: number
  outcome: 'ok' | 'failed'
}

/** Measures one startup phase without changing its return or error semantics. */
export async function measureStartupPhase<T>(
  phase: string,
  work: () => T | Promise<T>,
  report: (result: StartupPhaseReport) => void = (result) => console.info('[startup]', JSON.stringify(result)),
  now: () => number = () => performance.now()
): Promise<T> {
  const startedAt = now()
  let outcome: StartupPhaseReport['outcome'] = 'ok'
  try {
    return await work()
  } catch (error) {
    outcome = 'failed'
    throw error
  } finally {
    const durationMs = Math.max(0, Math.round(now() - startedAt))
    try { report({ phase, durationMs, outcome }) }
    catch { /* Observability must not change startup behavior. */ }
  }
}
