#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { FLOWS } = require('./run-critical-user-flows.cjs')

function assertFaultDetected({ flow, status, output }) {
  const faultMarker = `CRITICAL_FLOW_FAULT_INJECTED ${JSON.stringify({ flow })}`
  if (status === 0) throw new Error(`${flow} passed despite injected fault`)
  if (!output.includes(faultMarker)) throw new Error(`${flow} did not reach the injected fault`)
  if (!output.includes(`CRITICAL_FLOW_FAILURE ${flow}:`)) throw new Error(`${flow} did not fail its flow assertion`)
}

function run() {
  const runner = path.join(__dirname, 'run-critical-user-flows.cjs')
  for (const flow of FLOWS) {
    const child = spawnSync(process.execPath, [runner], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, CRITICAL_USER_FLOWS_ONLY: flow, CRITICAL_USER_FLOW_FAULT: flow },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 150_000
    })
    const output = `${child.stdout || ''}\n${child.stderr || ''}`
    if (child.error && child.status === null) throw new Error(`${flow} fault verification could not complete: ${child.error.message}\n${output}`)
    try { assertFaultDetected({ flow, status: child.status, output }) } catch (error) {
      throw new Error(`${error.message}\n${output}`)
    }
    console.log(`FAULT DETECTED ${flow}`)
  }
  console.log(`Critical user flow negative checks: ${FLOWS.length}/${FLOWS.length} injected regressions detected`)
}

if (require.main === module) {
  try { run() } catch (error) {
    console.error(error.stack || error)
    process.exitCode = 1
  }
}

module.exports = { assertFaultDetected }
