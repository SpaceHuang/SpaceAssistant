import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeVitestReport } from './summarize-vitest-report.mjs'

test('summarizes failed tests with safe names, statuses, durations and redacted errors', () => {
  const report = {
    testResults: [{
      name: '/runner/_work/SpaceAssistant/SpaceAssistant/electron/example.test.ts',
      assertionResults: [{
        fullName: 'rejects invalid permit',
        status: 'failed',
        duration: 17,
        failureMessages: ['AssertionError: expected "私密消息正文" after Authorization: Bearer ci-test-token-123 api_key=sk-test-key-123456 https://example.test/path?token=x\n    at run (src/test.ts:1:2)']
      }]
    }]
  }
  const summary = summarizeVitestReport(report, {
    platform: 'macOS arm64', nodeVersion: 'v22.1.0', commitSha: 'abc123def456', runUrl: 'https://github.com/org/repo/actions/runs/42'
  })
  assert.equal(summary.platform, 'macOS arm64')
  assert.equal(summary.nodeVersion, 'v22.1.0')
  assert.equal(summary.commitSha, 'abc123def456')
  assert.equal(summary.runUrl, 'https://github.com/org/repo/actions/runs/42')
  assert.equal(summary.failedTests.length, 1)
  assert.equal(summary.failedTests[0].file, 'electron/example.test.ts')
  assert.equal(summary.failedTests[0].name, 'rejects invalid permit')
  assert.equal(summary.failedTests[0].durationMs, 17)
  assert.doesNotMatch(JSON.stringify(summary), /私密消息正文|ci-test-token|sk-test-key|token=x|Authorization:|src\/test.ts/)
  assert.match(summary.failedTests[0].error, /\[REDACTED\]/)
})

test('counts all test states and tolerates malformed optional report fields', () => {
  const summary = summarizeVitestReport({ testResults: [{
    name: 'src/example.test.ts',
    assertionResults: [
      { fullName: 'passes', status: 'passed', duration: 3 },
      { fullName: 'skips', status: 'pending' }
    ]
  }] }, { platform: 'Windows x64', nodeVersion: 'v22.0.0' })
  assert.deepEqual(summary.counts, { passed: 1, failed: 0, skipped: 1, other: 0 })
  assert.deepEqual(summary.failedTests, [])
})

test('includes test files that fail during collection before individual tests start', () => {
  const summary = summarizeVitestReport({ testResults: [{
    name: '/runner/SpaceAssistant/electron/broken.test.ts',
    status: 'failed',
    startTime: 100,
    endTime: 112,
    assertionResults: [],
    message: 'Failed to load test module\n    at collect (electron/broken.test.ts:1:2)'
  }] }, { platform: 'macOS arm64', nodeVersion: 'v22.1.0' })
  assert.deepEqual(summary.counts, { passed: 0, failed: 1, skipped: 0, other: 0 })
  assert.equal(summary.failedTests[0].file, 'electron/broken.test.ts')
  assert.equal(summary.failedTests[0].name, 'test file failed to load')
  assert.equal(summary.failedTests[0].durationMs, 12)
  assert.equal(summary.failedTests[0].error, 'Failed to load test module')
})

test('renders Windows runner paths relative to the checked-out workspace', () => {
  const summary = summarizeVitestReport({ testResults: [{
    name: 'D:\\a\\SpaceAssistant\\SpaceAssistant\\electron\\broken.test.ts',
    assertionResults: [{ fullName: 'fails', status: 'failed', failureMessages: ['expected false to be true'] }]
  }] }, {
    platform: 'Windows x64', nodeVersion: 'v22.1.0', workspace: 'D:\\a\\SpaceAssistant\\SpaceAssistant'
  })
  assert.equal(summary.failedTests[0].file, 'electron/broken.test.ts')
})

test('renders worktree report paths relative to the active checkout', () => {
  const workspace = process.cwd()
  const summary = summarizeVitestReport({ testResults: [{
    name: `${workspace}/packages/example.test.ts`,
    assertionResults: [{ fullName: 'fails', status: 'failed', failureMessages: ['expected false to be true'] }]
  }] }, { platform: 'macOS arm64', nodeVersion: 'v22.1.0', workspace })
  assert.equal(summary.failedTests[0].file, 'packages/example.test.ts')
})
