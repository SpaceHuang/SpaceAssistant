import { describe, expect, it } from 'vitest'
import { summarizeSessionProjectionObservation } from './sessionProjectionObservation'

const window = { appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111',
  from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z', maxReadP95Ms: 20,
  minimumReadSamples: 2, minimumShadowSamples: 1,
  requiredPathCoverage: ['read:transcript:canonical', 'shadow:api-context:matched'] }

describe('session projection release observation summary', () => {
  it('summarizes one version and window, read latency, shadow parity, recovery and cutover incidents', () => {
    const report = summarizeSessionProjectionObservation([
      { ts: '2026-10-01T01:00:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.transcript.read', consumer: 'transcript', outcome: 'canonical', durationMs: 7 },
      { ts: '2026-10-01T02:00:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.transcript.read', consumer: 'transcript', outcome: 'legacy', durationMs: 15 },
      { ts: '2026-10-01T03:00:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.storage.shadow', consumer: 'api-context', status: 'matched', differenceCount: 0 },
      { ts: '2026-10-01T04:00:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.transcript.reconciliation', level: 'error', errorCode: 'RECONCILIATION_FAILED' },
      { ts: '2026-10-01T04:30:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.history.recovery', level: 'warn', outcome: 'degraded', failed: 2, durationMs: 43 },
      { ts: '2026-10-01T05:00:00.000Z', appVersion: '0.2.4', artifactBuildId: window.artifactBuildId, event: 'session.transcript.read', outcome: 'failed', durationMs: 90 }
    ], window)

    expect(report).toMatchObject({ readCount: 2, canonicalReadCount: 1, legacyReadCount: 1, failedReadCount: 0,
      readP50Ms: 7, readP95Ms: 15, shadowComparisonCount: 1, shadowMismatchCount: 0,
      recoveryFailureCount: 2, cutoverRejectionCount: 0, withinReadBudget: true, observationComplete: false,
      issues: ['recovery-failure-observed'] })
    expect(report.incidents).toEqual([
      { ts: '2026-10-01T04:00:00.000Z', event: 'session.transcript.reconciliation', level: 'error', code: 'RECONCILIATION_FAILED' },
      { ts: '2026-10-01T04:30:00.000Z', event: 'session.history.recovery', level: 'warn' }
    ])
  })

  it('does not pass an empty or incomplete observation window', () => {
    const report = summarizeSessionProjectionObservation([
      { ts: '2026-10-01T01:00:00.000Z', appVersion: '0.2.4', artifactBuildId: window.artifactBuildId, event: 'session.transcript.read', outcome: 'canonical', durationMs: 1 }
    ], window)

    expect(report).toMatchObject({ readCount: 0, readP95Ms: null, withinReadBudget: false, observationComplete: false,
      issues: expect.arrayContaining(['no-versioned-events-in-window', 'no-transcript-read-samples', 'no-shadow-comparison-samples',
        'insufficient-transcript-read-samples', 'insufficient-shadow-comparison-samples', 'required-path-coverage-missing']) })
  })

  it('blocks observation completion on differences, failed reads, missing timings, or latency regression', () => {
    const report = summarizeSessionProjectionObservation([
      { ts: '2026-10-01T01:00:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.transcript.read', consumer: 'transcript', outcome: 'failed', errorCode: 'CANONICAL_SESSION_CONTENT_UNAVAILABLE' },
      { ts: '2026-10-01T01:10:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.transcript.read', consumer: 'transcript', outcome: 'canonical', durationMs: 30 },
      { ts: '2026-10-01T01:20:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.storage.shadow', consumer: 'api-context', status: 'mismatched', differenceCount: 1 },
      { ts: '2026-10-01T01:30:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'history.cutover', outcome: 'rejected', level: 'warn' }
    ], window)

    expect(report).toMatchObject({ readCount: 2, failedReadCount: 1, readP95Ms: 30, withinReadBudget: false,
      shadowMismatchCount: 1, cutoverRejectionCount: 1, observationComplete: false,
      issues: expect.arrayContaining(['read-duration-sample-missing', 'transcript-read-failure-observed',
        'shadow-difference-observed', 'cutover-rejection-observed', 'transcript-read-budget-exceeded']) })
    expect(report.incidents).toHaveLength(3)
    expect(() => summarizeSessionProjectionObservation([], { ...window, maxReadP95Ms: 0 })).toThrow(RangeError)
  })

  it('blocks retirement observation on startup recovery being skipped or a legacy cutover fallback', () => {
    const report = summarizeSessionProjectionObservation([
      { ts: '2026-10-01T01:00:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.transcript.read', consumer: 'transcript', outcome: 'canonical', durationMs: 4 },
      { ts: '2026-10-01T01:10:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.storage.shadow', consumer: 'api-context', status: 'matched', differenceCount: 0 },
      { ts: '2026-10-01T01:20:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'session.transcript.reconciliation', level: 'info', outcome: 'startup-blocked' },
      { ts: '2026-10-01T01:30:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId, event: 'history.cutover', level: 'warn', outcome: 'legacy-fallback' }
    ], window)

    expect(report).toMatchObject({ recoveryFailureCount: 1, cutoverRejectionCount: 1, observationComplete: false,
      issues: expect.arrayContaining(['insufficient-transcript-read-samples', 'recovery-failure-observed', 'cutover-rejection-observed']) })
  })

  it('does not combine samples across build identities and blocks below protocol minima or missing path coverage', () => {
    const report = summarizeSessionProjectionObservation([
      { ts: '2026-10-01T01:00:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId,
        event: 'session.transcript.read', consumer: 'transcript', outcome: 'canonical', durationMs: 1 },
      { ts: '2026-10-01T01:10:00.000Z', appVersion: '0.2.5', artifactBuildId: '22222222-2222-4222-8222-222222222222',
        event: 'session.transcript.read', consumer: 'transcript', outcome: 'canonical', durationMs: 1 },
      { ts: '2026-10-01T01:20:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId,
        event: 'session.storage.shadow', consumer: 'api-context', status: 'matched', differenceCount: 0 }
    ], window)
    expect(report).toMatchObject({ readCount: 1, shadowComparisonCount: 1, observationComplete: false,
      issues: expect.arrayContaining(['insufficient-transcript-read-samples']) })
    const missingPathReport = summarizeSessionProjectionObservation([
      { ts: '2026-10-01T01:00:00.000Z', appVersion: '0.2.5', artifactBuildId: window.artifactBuildId,
        event: 'session.transcript.read', consumer: 'transcript', outcome: 'canonical', durationMs: 1 }
    ], { ...window, requiredPathCoverage: ['read:transcript:legacy'] })
    expect(missingPathReport.issues).toContain('required-path-coverage-missing')
  })
})
