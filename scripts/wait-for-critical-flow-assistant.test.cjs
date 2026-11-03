'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { waitForCriticalFlowAssistant } = require('./wait-for-critical-flow-assistant.cjs')

test('waits for visible reply and terminal turn before reading persisted assistant messages', async () => {
  const events = []
  let activeReads = 0
  const result = await waitForCriticalFlowAssistant({
    sessionId: 'session-1',
    text: 'reply',
    stage: (name) => events.push(`stage:${name}`),
    waitFor: async (description, check) => {
      events.push(`wait:${description}`)
      while (true) {
        const value = await check()
        if (value) return value
      }
    },
    assistantIsVisible: async () => true,
    listActiveTurns: async () => {
      activeReads += 1
      return activeReads < 3 ? [{ turnId: 'turn-1' }] : []
    },
    readMessages: async () => {
      events.push('read-messages')
      assert.equal(activeReads, 3)
      return [{ role: 'assistant', status: 'completed', content: 'reply' }]
    }
  })

  assert.equal(result.assistant.status, 'completed')
  assert.equal(activeReads, 3)
  assert.ok(events.indexOf('stage:assistant-visible') < events.indexOf('wait:assistant turn terminal'))
  assert.ok(events.indexOf('stage:assistant-turn-terminal') < events.indexOf('read-messages'))
})

test('rejects a visible reply that is not committed as a completed assistant message', async () => {
  await assert.rejects(() => waitForCriticalFlowAssistant({
    sessionId: 'session-1',
    text: 'reply',
    stage: () => undefined,
    waitFor: async (_description, check) => check(),
    assistantIsVisible: async () => true,
    listActiveTurns: async () => [],
    readMessages: async () => [{ role: 'assistant', status: 'streaming', content: 'reply' }]
  }), /completed assistant message was not committed/)
})
