import test from 'node:test'
import assert from 'node:assert/strict'
import { REQUIRED_RESULTS, summarizeResults } from './check-ci-required-results.mjs'

const successfulResults = Object.fromEntries(Object.keys(REQUIRED_RESULTS).map((id) => [id, { result: 'success' }]))

test('accepts only when all eight required jobs succeeded', () => {
  const summary = summarizeResults(successfulResults)
  assert.equal(summary.success, true)
  assert.equal(summary.failed.length, 0)
})

for (const result of ['failure', 'cancelled', 'skipped', 'neutral', 'unknown']) {
  test(`fails closed when a required job result is ${result}`, () => {
    const needs = structuredClone(successfulResults)
    needs.shell_windows_x64.result = result
    const summary = summarizeResults(needs)
    assert.equal(summary.success, false)
    assert.deepEqual(summary.failed.map(({ jobId, result: actual }) => [jobId, actual]), [['shell_windows_x64', result]])
  })
}

test('fails closed and identifies a missing required result', () => {
  const needs = structuredClone(successfulResults)
  delete needs.sqlite_macos_arm64
  const summary = summarizeResults(needs)
  assert.equal(summary.success, false)
  assert.deepEqual(summary.failed.map(({ jobId, result }) => [jobId, result]), [['sqlite_macos_arm64', 'missing']])
})
