import test from 'node:test'
import assert from 'node:assert/strict'
import { createFixtureDefinition } from './session-storage-full-chain-options.mjs'

test('context summary is a selectable bounded benchmark scenario', () => {
  const { fixture } = createFixtureDefinition(['--only=context-summary', '--quick', '--seed=17'])
  assert.deepEqual(fixture.scenarios, [{ kind: 'context-summary', count: 1000, bodyBytes: 1024 }])
  assert.equal(fixture.seed, 17)
})
