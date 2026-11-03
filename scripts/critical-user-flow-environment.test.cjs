const test = require('node:test')
const assert = require('node:assert/strict')
const { configureCriticalFlowLocale } = require('./critical-user-flow-environment.cjs')

test('sets a deterministic renderer locale before the Electron app becomes ready', () => {
  const calls = []
  const app = { commandLine: { appendSwitch: (...args) => calls.push(args) } }
  configureCriticalFlowLocale(app)
  assert.deepEqual(calls, [['lang', 'zh-CN']])
})
