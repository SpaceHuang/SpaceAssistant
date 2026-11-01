import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeFailureReview } from './ci-failure-review.mjs'

const runs = [
  { runId: '3', branch: 'main', conclusion: 'failure', createdAt: '2026-02-03T00:00:00Z', url: 'https://github.com/org/repo/actions/runs/3' },
  { runId: '2', branch: 'main', conclusion: 'failure', createdAt: '2026-02-02T00:00:00Z', url: 'https://github.com/org/repo/actions/runs/2' },
  { runId: '1', branch: 'main', conclusion: 'success', createdAt: '2026-02-01T00:00:00Z', url: 'https://github.com/org/repo/actions/runs/1' }
]

const reviews = [
  { incidentId: 'a', runId: '2', category: 'test-fixture', rootCauseId: 'fixture-race', rootCause: 'fixture spawned Electron from a test worker', firstFailureAt: '2026-02-02T00:00:00Z', locatedAt: '2026-02-02T01:00:00Z', fixedAt: '2026-02-02T02:00:00Z', fixCommit: 'abc123', verificationRunId: '4', closureEvidence: 'pure fixture helper plus passing full CI', rerunOnlyClosure: false },
  { incidentId: 'b', runId: '3', category: 'code-contract', rootCauseId: 'timeout-reporting', rootCause: 'deadline expiry returned an unmarked no-match result', firstFailureAt: '2026-02-03T00:00:00Z', locatedAt: '2026-02-03T00:30:00Z', fixedAt: '2026-02-03T01:30:00Z', fixCommit: 'def456', verificationRunId: '5', closureEvidence: 'regression test and passing full CI', rerunOnlyClosure: false },
  { incidentId: 'c', runId: '3', category: 'concurrency-resource', rootCauseId: 'ui-mock-cascade', rootCause: 'timed UI test left one-shot replies queued for later tests', firstFailureAt: '2026-02-03T00:00:00Z', locatedAt: null, fixedAt: null, fixCommit: null, verificationRunId: null, closureEvidence: null, rerunOnlyClosure: false }
]

test('summarizes failure categories, diagnosis/fix times and repeated causes', () => {
  const summary = summarizeFailureReview({ mainRuns: runs, reviews })
  assert.equal(summary.twoConsecutiveMainFailures, true)
  assert.deepEqual(summary.categoryCounts, { 'test-fixture': 1, 'code-contract': 1, 'concurrency-resource': 1 })
  assert.equal(summary.incidentCount, 3)
  assert.equal(summary.unresolvedCount, 1)
  assert.equal(summary.diagnosisMedianMinutes, 45)
  assert.equal(summary.fixMedianMinutes, 105)
  assert.deepEqual(summary.repeatedRootCauses, [])
})

test('does not report a consecutive-failure trigger when success breaks the sequence', () => {
  const summary = summarizeFailureReview({ mainRuns: [{ ...runs[0], conclusion: 'success' }, runs[1], runs[2]], reviews })
  assert.equal(summary.twoConsecutiveMainFailures, false)
})

test('rejects closure based only on a green rerun', () => {
  const changed = structuredClone(reviews)
  changed[0].rerunOnlyClosure = true
  assert.throws(() => summarizeFailureReview({ mainRuns: runs, reviews: changed }), /rerun alone cannot close/)
})

test('rejects missing or invalid review timing and categories', () => {
  const badTime = structuredClone(reviews)
  badTime[1].fixedAt = 'not-a-time'
  assert.throws(() => summarizeFailureReview({ mainRuns: runs, reviews: badTime }), /fixedAt/)

  const badCategory = structuredClone(reviews)
  badCategory[1].category = 'flaky'
  assert.throws(() => summarizeFailureReview({ mainRuns: runs, reviews: badCategory }), /category/)
})
