import test from 'node:test'
import assert from 'node:assert/strict'
import { createFixtureDefinition } from './session-storage-full-chain-options.mjs'

test('context summary is a selectable bounded benchmark scenario', () => {
  const { fixture } = createFixtureDefinition(['--only=context-summary', '--quick', '--seed=17'])
  assert.deepEqual(fixture.scenarios, [{ kind: 'context-summary', scenarioId: 'context-summary-1000', count: 1000, bodyBytes: 1024 }])
  assert.equal(fixture.seed, 17)
})

test('assigns unique identities to event scenarios with different pending counts', () => {
  const { fixture } = createFixtureDefinition(['--samples=1'])
  const events = fixture.scenarios.filter(({ kind, count }) => kind === 'events' && count === 800)
  assert.equal(new Set(events.map(({ scenarioId }) => scenarioId)).size, events.length)
})
