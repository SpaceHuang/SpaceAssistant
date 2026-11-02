import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeStoragePerfReport } from './summarize-storage-perf-report.mjs'

test('emits only allowlisted storage performance test names, elapsed time, and conclusion', () => {
  const summary = summarizeStoragePerfReport({ testResults: [{ assertionResults: [
    { fullName: 'keeps paired warm API shadow p95 within the Phase 2 regression ceiling', status: 'passed', duration: 31 },
    { fullName: 'measures the canonical API selector and ID-body candidate against getTurnContext', status: 'failed', duration: 15 }
  ] }] })
  assert.deepEqual(summary.slice(0, 2), [
    { testName: 'paired warm API shadow', elapsedMs: 31, conclusion: 'passed' },
    { testName: 'canonical API selector', elapsedMs: 15, conclusion: 'failed' }
  ])
  assert.deepEqual(Object.keys(summary[0]).sort(), ['conclusion', 'elapsedMs', 'testName'])
})

test('marks missing selected tests as not reported so a partial run cannot look complete', () => {
  const summary = summarizeStoragePerfReport({ testResults: [] })
  assert.equal(summary.length, 9)
  assert.ok(summary.every((item) => item.conclusion === 'not-reported' && item.elapsedMs === null))
})
