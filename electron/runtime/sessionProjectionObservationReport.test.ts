import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionProjectionObservationReport } from '../../scripts/session-projection-observation-report'

const protocolArgs = ['--artifact-build-id', '11111111-1111-4111-8111-111111111111', '--min-read-samples', '2',
  '--min-shadow-samples', '1', '--require-path', 'read:transcript:canonical', '--require-path', 'shadow:api-context:matched']

describe('session projection observation report CLI', () => {
  let tempDir = ''
  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }), tempDir = ''
  })

  it('reads rotated agent logs and creates a version/window-specific summary', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-projection-observation-'))
    await fs.mkdir(path.join(tempDir, 'nested'))
    await fs.writeFile(path.join(tempDir, 'Agent-20261001.log'), [
      { ts: '2026-10-01T01:00:00.000Z', level: 'info', event: 'session.transcript.read', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', consumer: 'transcript', source: 'canonical:L2', outcome: 'canonical', durationMs: 8 },
      { ts: '2026-10-01T02:00:00.000Z', level: 'info', event: 'session.storage.shadow', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', consumer: 'api-context', source: 'canonical:L2', status: 'matched', differenceCount: 0 },
      { ts: '2026-10-01T02:30:00.000Z', level: 'info', event: 'session.history.recovery', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', outcome: 'completed', reconciledCount: 2, failed: 0, durationMs: 20 },
      { ts: '2026-10-01T02:40:00.000Z', level: 'info', event: 'session.transcript.reconciliation', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', outcome: 'startup-scan', reconciledCount: 0 },
      { ts: '2026-10-01T02:50:00.000Z', level: 'info', event: 'history.cutover', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', stage: 'session-checkpoint', reasonCode: 'committed-transcript', outcome: 'matched' },
      { ts: '2026-10-01T03:00:00.000Z', level: 'info', event: 'llm.response', appVersion: '0.2.5' }
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    await fs.writeFile(path.join(tempDir, 'nested', 'Agent-20261002.log'), [
      { ts: '2026-10-02T01:00:00.000Z', level: 'info', event: 'session.transcript.read', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', consumer: 'transcript', source: 'legacy', outcome: 'legacy', durationMs: 12 }
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    const report = await createSessionProjectionObservationReport([
      '--version', '0.2.5', ...protocolArgs, '--from', '2026-10-01T00:00:00Z', '--to', '2026-10-03T00:00:00Z', '--max-read-p95-ms', '20', tempDir
    ])

    expect(report).toMatchObject({ appVersion: '0.2.5', readCount: 2, canonicalReadCount: 1, legacyReadCount: 1,
      readP95Ms: 12, shadowComparisonCount: 1, recoveryFailureCount: 0, cutoverRejectionCount: 0, observationComplete: true })
  })

  it('keeps empty input visibly incomplete instead of accepting a vacuous observation', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-projection-observation-empty-'))
    const report = await createSessionProjectionObservationReport([
      '--version', '0.2.5', ...protocolArgs, '--from', '2026-10-01T00:00:00Z', '--to', '2026-10-03T00:00:00Z', '--max-read-p95-ms', '20', tempDir
    ])
    expect(report).toMatchObject({ observationComplete: false, issues: expect.arrayContaining(['no-versioned-events-in-window', 'no-transcript-read-samples',
      'no-shadow-comparison-samples', 'insufficient-transcript-read-samples', 'insufficient-shadow-comparison-samples', 'required-path-coverage-missing']) })
  })

  it('requires protocol-approved sample thresholds and path coverage before reading logs', async () => {
    await expect(createSessionProjectionObservationReport([
      '--version', '0.2.5', '--artifact-build-id', '11111111-1111-4111-8111-111111111111',
      '--from', '2026-10-01T00:00:00Z', '--to', '2026-10-03T00:00:00Z', '--max-read-p95-ms', '20', os.tmpdir()
    ])).rejects.toThrow('usage:')
  })

  it('marks malformed log lines incomplete so missing incident data cannot pass', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-projection-observation-malformed-'))
    await fs.writeFile(path.join(tempDir, 'Agent-20261001.log'), [
      JSON.stringify({ ts: '2026-10-01T01:00:00.000Z', level: 'info', event: 'session.transcript.read', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', consumer: 'transcript', source: 'canonical:L2', outcome: 'canonical', durationMs: 8 }),
      '{broken json'
    ].join('\n'), 'utf8')

    const report = await createSessionProjectionObservationReport([
      '--version', '0.2.5', ...protocolArgs, '--from', '2026-10-01T00:00:00Z', '--to', '2026-10-03T00:00:00Z', '--max-read-p95-ms', '20', tempDir
    ])

    expect(report).toMatchObject({ malformedRecordCount: 1, observationComplete: false,
      issues: expect.arrayContaining(['no-shadow-comparison-samples', 'malformed-log-records']) })
  })

  it('rejects valid JSON observation records with unknown transcript outcomes', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-projection-observation-invalid-shape-'))
    await fs.writeFile(path.join(tempDir, 'Agent-20261001.log'), [
      { ts: '2026-10-01T01:00:00.000Z', level: 'info', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', event: 'session.transcript.read', consumer: 'transcript', source: 'canonical:L2', outcome: 'future-state', durationMs: 8 },
      { ts: '2026-10-01T01:30:00.000Z', level: 'error', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', event: 'session.transcript.read', consumer: 'transcript', source: 'unavailable', outcome: 'failed', durationMs: 8 },
      { ts: '2026-10-01T01:45:00.000Z', level: 'error', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', event: 'session.transcript.read', consumer: 'transcript', source: 'unavailable', outcome: 'failed', errorCode: 'private error detail', durationMs: 8 },
      { ts: '2026-10-01T02:00:00.000Z', level: 'info', appVersion: '0.2.5', artifactBuildId: '11111111-1111-4111-8111-111111111111', event: 'session.storage.shadow', consumer: 'api-context', source: 'canonical:L2', status: 'matched', differenceCount: 0 }
    ].map((row) => JSON.stringify(row)).join('\n'), 'utf8')

    const report = await createSessionProjectionObservationReport([
      '--version', '0.2.5', ...protocolArgs, '--from', '2026-10-01T00:00:00Z', '--to', '2026-10-03T00:00:00Z', '--max-read-p95-ms', '20', tempDir
    ])

    expect(report).toMatchObject({ readCount: 0, canonicalReadCount: 0, malformedRecordCount: 3,
      observationComplete: false, issues: expect.arrayContaining(['no-transcript-read-samples', 'insufficient-transcript-read-samples',
        'required-path-coverage-missing', 'malformed-log-records']) })
  })
})
