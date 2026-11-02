const test = require('node:test')
const assert = require('node:assert/strict')

const { parsePushInput, buildCheckCommands, shouldSkip, runCommands } = require('./check-pre-push.cjs')

const zero = '0000000000000000000000000000000000000000'

test('parses multiple push refs and excludes branch deletions', () => {
  assert.deepEqual(parsePushInput([
    `refs/heads/topic abc123 refs/heads/topic def456`,
    `refs/heads/remove ${zero} refs/heads/remove abc789`
  ].join('\n')), [{ localRef: 'refs/heads/topic', localSha: 'abc123', remoteRef: 'refs/heads/topic', remoteSha: 'def456' }])
})

test('runs renderer typecheck and related tests for renderer changes', () => {
  const commands = buildCheckCommands(['src/renderer/App.tsx', 'src/renderer/App.tsx'])
  assert.ok(commands.some(({ args }) => args.join(' ') === 'run typecheck:renderer'))
  assert.ok(commands.some(({ args }) => args.join(' ') === 'run test:related -- src/renderer/App.tsx'))
})

test('runs the Agent SDK typecheck for package changes and does not run related tests for docs only', () => {
  const sdkCommands = buildCheckCommands(['packages/agent-sdk/src/sessionContext.ts'])
  assert.ok(sdkCommands.some(({ args }) => args.join(' ') === 'run typecheck:agent-sdk'))
  assert.ok(sdkCommands.some(({ args }) => args.includes('test:related')))
  const docsCommands = buildCheckCommands(['docs/develop/platform-eng/testing-guide.md'])
  assert.ok(!docsCommands.some(({ args }) => args.includes('test:related')))
})

test('skip is enabled only by the explicit value 1', () => {
  assert.equal(shouldSkip({ SPACEASSISTANT_SKIP_PRE_PUSH: '1' }), true)
  assert.equal(shouldSkip({ SPACEASSISTANT_SKIP_PRE_PUSH: 'true' }), false)
  assert.equal(shouldSkip({}), false)
})

test('stops at the first failed check and returns its exit status', () => {
  const calls = []
  const result = runCommands([
    { label: 'first', args: ['run', 'check:no-nul'] },
    { label: 'failed', args: ['run', 'test:related'] },
    { label: 'never', args: ['run', 'typecheck:renderer'] }
  ], (_command, args) => {
    calls.push(args)
    return { status: args.includes('test:related') ? 2 : 0 }
  })
  assert.equal(result.status, 2)
  assert.deepEqual(calls.map((args) => args[1]), ['check:no-nul', 'test:related'])
})
