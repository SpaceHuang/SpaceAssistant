import test from 'node:test'
import assert from 'node:assert/strict'
import { REQUIRED_RESULTS, formatResultSummary, summarizeResults } from './check-ci-required-results.mjs'

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

test('formats run identity, attempt link and labeled failure details', () => {
  const needs = structuredClone(successfulResults)
  needs.shell_windows_x64.result = 'cancelled'
  const result = formatResultSummary(needs, {
    commitSha: '1234567890abcdef', runId: '456', runAttempt: '2',
    actionsUrl: 'https://github.com/org/repo/actions/runs/456'
  })
  assert.equal(result.summary.success, false)
  assert.match(result.output, /commit 1234567890abcdef, run 456, attempt 2/)
  assert.match(result.output, /https:\/\/github.com\/org\/repo\/actions\/runs\/456\/attempts\/2/)
  assert.match(result.output, /shell_windows_x64 \(Windows x64\): cancelled/)
  assert.match(result.output, /CI required failed: shell_windows_x64 \(Windows x64\)=cancelled/)
})
