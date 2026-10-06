export type SessionProjectionObservationEvent = Readonly<{
  ts?: string
  event?: string
  appVersion?: string
  artifactBuildId?: string
  level?: string
  consumer?: string
  source?: string
  outcome?: string
  status?: string
  durationMs?: number
  differenceCount?: number
  failed?: number
  errorCode?: string
}>

export type SessionProjectionObservationReport = Readonly<{
  appVersion: string
  artifactBuildId: string
  from: string
  to: string
  readCount: number
  canonicalReadCount: number
  legacyReadCount: number
  failedReadCount: number
  readP50Ms: number | null
  readP95Ms: number | null
  shadowComparisonCount: number
  shadowMismatchCount: number
  minimumReadSamples: number
  minimumShadowSamples: number
  requiredPathCoverage: readonly string[]
  observedPathCoverage: readonly string[]
  recoveryFailureCount: number
  cutoverRejectionCount: number
  malformedRecordCount: number
  incidents: readonly Readonly<{ ts: string; event: string; level: string; code?: string }>[]
  withinReadBudget: boolean
  observationComplete: boolean
  issues: readonly string[]
}>

function percentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)]!
}

/** Summarize sanitized agent-log rows for one release version and an explicitly agreed window. */
export function summarizeSessionProjectionObservation(
  events: readonly SessionProjectionObservationEvent[],
  options: Readonly<{ appVersion: string; artifactBuildId: string; from: string; to: string; maxReadP95Ms: number;
    minimumReadSamples: number; minimumShadowSamples: number; requiredPathCoverage: readonly string[]; malformedRecordCount?: number }>
): SessionProjectionObservationReport {
  const fromMs = Date.parse(options.from)
  const toMs = Date.parse(options.to)
  if (!options.appVersion.trim() || !/^[0-9a-f-]{36}$/i.test(options.artifactBuildId) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs ||
    !Number.isFinite(options.maxReadP95Ms) || options.maxReadP95Ms <= 0 ||
    !Number.isSafeInteger(options.minimumReadSamples) || options.minimumReadSamples < 1 ||
    !Number.isSafeInteger(options.minimumShadowSamples) || options.minimumShadowSamples < 1 ||
    options.requiredPathCoverage.length === 0 || options.requiredPathCoverage.some((item) => !item.trim())) {
    throw new RangeError('appVersion, artifactBuildId, ordered ISO window, positive budgets/sample minima, and required path coverage are required')
  }
  const inWindow = events.filter((event) => {
    const ts = Date.parse(event.ts ?? '')
    return event.appVersion === options.appVersion && event.artifactBuildId === options.artifactBuildId && Number.isFinite(ts) && ts >= fromMs && ts <= toMs
  })
  const reads = inWindow.filter(({ event }) => event === 'session.transcript.read')
  const durations = reads.flatMap(({ durationMs }) => typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? [durationMs] : [])
  const canonicalReadCount = reads.filter(({ outcome }) => outcome === 'canonical').length
  const legacyReadCount = reads.filter(({ outcome }) => outcome === 'legacy').length
  const failedReadCount = reads.filter(({ outcome }) => outcome === 'failed').length
  const shadows = inWindow.filter(({ event }) => event === 'session.storage.shadow')
  const observedPathCoverage = [...new Set([
    ...reads.map(({ consumer, outcome }) => `read:${consumer ?? 'unknown'}:${outcome ?? 'unknown'}`),
    ...shadows.map(({ consumer, status }) => `shadow:${consumer ?? 'unknown'}:${status ?? 'unknown'}`)
  ])].sort()
  const missingRequiredPaths = options.requiredPathCoverage.filter((item) => !observedPathCoverage.includes(item))
  const shadowMismatchCount = shadows.filter(({ status, differenceCount }) => status !== 'matched' || (differenceCount ?? 0) > 0).length
  const recoveries = inWindow.filter(({ event }) => event === 'session.transcript.reconciliation' || event === 'session.history.recovery')
  const recoveryFailures = recoveries.filter(({ level, outcome, failed }) => level === 'error' || level === 'warn' ||
    outcome === 'degraded' || outcome === 'startup-blocked' || outcome === 'startup-failed' || outcome === 'commit_uncertain' ||
    (typeof failed === 'number' && failed > 0))
  const cutovers = inWindow.filter(({ event }) => event === 'history.cutover')
  const cutoverRejections = cutovers.filter(({ outcome, level }) => outcome === 'rejected' || outcome === 'legacy-fallback' || level === 'error')
  const incidentEvents = [
    ...reads.filter(({ outcome }) => outcome === 'failed'),
    ...shadows.filter(({ status, differenceCount }) => status !== 'matched' || (differenceCount ?? 0) > 0),
    ...recoveryFailures,
    ...cutoverRejections
  ]
  const issues: string[] = []
  if (inWindow.length === 0) issues.push('no-versioned-events-in-window')
  if (reads.length === 0) issues.push('no-transcript-read-samples')
  if (shadows.length === 0) issues.push('no-shadow-comparison-samples')
  if (reads.length < options.minimumReadSamples) issues.push('insufficient-transcript-read-samples')
  if (shadows.length < options.minimumShadowSamples) issues.push('insufficient-shadow-comparison-samples')
  if (missingRequiredPaths.length > 0) issues.push('required-path-coverage-missing')
  if (durations.length !== reads.length) issues.push('read-duration-sample-missing')
  if (failedReadCount > 0) issues.push('transcript-read-failure-observed')
  if (shadowMismatchCount > 0) issues.push('shadow-difference-observed')
  if (recoveryFailures.length > 0) issues.push('recovery-failure-observed')
  if (cutoverRejections.length > 0) issues.push('cutover-rejection-observed')
  const readP50Ms = percentile(durations, 0.5)
  const readP95Ms = percentile(durations, 0.95)
  const withinReadBudget = readP95Ms !== null && readP95Ms <= options.maxReadP95Ms
  if (readP95Ms !== null && !withinReadBudget) issues.push('transcript-read-budget-exceeded')
  const malformedRecordCount = options.malformedRecordCount ?? 0
  if (malformedRecordCount > 0) issues.push('malformed-log-records')
  return {
    appVersion: options.appVersion, artifactBuildId: options.artifactBuildId,
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
    readCount: reads.length, canonicalReadCount, legacyReadCount, failedReadCount,
    readP50Ms, readP95Ms, shadowComparisonCount: shadows.length, shadowMismatchCount,
    minimumReadSamples: options.minimumReadSamples, minimumShadowSamples: options.minimumShadowSamples,
    requiredPathCoverage: [...options.requiredPathCoverage], observedPathCoverage,
    recoveryFailureCount: recoveryFailures.length, cutoverRejectionCount: cutoverRejections.length,
    malformedRecordCount,
    incidents: incidentEvents.flatMap((item) => item.ts && item.event ? [{
      ts: item.ts, event: item.event, level: item.level ?? 'unknown', ...(item.errorCode ? { code: item.errorCode } : {})
    }] : []),
    withinReadBudget, observationComplete: issues.length === 0, issues
  }
}
