const test = require('node:test')
const assert = require('node:assert/strict')

const { assertFaultDetected } = require('./verify-critical-user-flow-faults.cjs')

test('accepts a nonzero flow result only when its intended fault and assertion failure are reported', () => {
  assert.doesNotThrow(() => assertFaultDetected({
    flow: 'new-session',
    status: 1,
    output: 'CRITICAL_FLOW_FAULT_INJECTED {"flow":"new-session"}\nCRITICAL_FLOW_FAILURE new-session: expected assistant result'
  }))
})

test('rejects a flow that passes despite the injected fault', () => {
  assert.throws(() => assertFaultDetected({
    flow: 'new-session', status: 0,
    output: 'CRITICAL_FLOW_FAULT_INJECTED {"flow":"new-session"}'
  }), /passed despite injected fault/)
})

test('rejects a nonzero exit caused before the intended fault was injected', () => {
  assert.throws(() => assertFaultDetected({
    flow: 'restart-recovery', status: 1,
    output: 'CRITICAL_FLOW_FAILURE restart-recovery: renderer did not start'
  }), /did not reach the injected fault/)
})

test('rejects a failure that does not come from the flow assertion', () => {
  assert.throws(() => assertFaultDetected({
    flow: 'tool-roundtrip', status: 1,
    output: 'CRITICAL_FLOW_FAULT_INJECTED {"flow":"tool-roundtrip"}\nElectron crashed'
  }), /did not fail its flow assertion/)
})
