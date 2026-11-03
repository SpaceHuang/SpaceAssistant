'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  waitForCriticalFlowReadConfirmation,
  waitForCriticalFlowToolApprovalAccepted
} = require('./wait-for-critical-flow-confirmation.cjs')

function pollingWaitFor(_description, check, _timeoutMs) {
  return (async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await check()
      if (result) return result
    }
    throw new Error('confirmation condition did not become true')
  })()
}

test('waits for the host confirmation snapshot before allowing the UI click', async () => {
  const turn = {
    sessionId: 'session-1', turnId: 'turn-1', requestId: 'request-1', version: 7,
    assistantMessage: { toolCalls: [{ id: 'tool-1', toolName: 'read_file', status: 'confirming' }] }
  }
  const readConfirmation = async (input) => {
    assert.deepEqual(input, { sessionId: 'session-1', turnId: 'turn-1', requestId: 'request-1', turnVersion: 7, toolCallId: 'tool-1' })
    return ++reads === 1 ? { status: 'stale' } : { toolCallId: 'tool-1', confirmation: { complete: true } }
  }
  let reads = 0

  await assert.doesNotReject(() => waitForCriticalFlowReadConfirmation({
    sessionId: 'session-1', toolName: 'read_file', waitFor: pollingWaitFor,
    listActiveTurns: async () => [turn], readConfirmation
  }))
  assert.equal(reads, 2)
})

test('waits until the host leaves confirming state after the user approval click', async () => {
  let status = 'confirming'
  const listActiveTurns = async () => [{
    sessionId: 'session-1', turnId: 'turn-1',
    assistantMessage: { toolCalls: [{ id: 'tool-1', status }] }
  }]
  const result = waitForCriticalFlowToolApprovalAccepted({
    sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'tool-1', waitFor: pollingWaitFor,
    listActiveTurns: async () => {
      const turns = await listActiveTurns()
      status = 'executing'
      return turns
    }
  })

  await assert.doesNotReject(result)
})
