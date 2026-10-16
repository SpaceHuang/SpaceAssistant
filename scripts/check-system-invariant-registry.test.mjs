import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts/check-system-invariant-registry.mjs')
const registry = fs.readFileSync(path.join(root, 'src/shared/security/systemInvariantRegistry.ts'), 'utf8')

function run(source) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SYSTEM_INVARIANT_REGISTRY_SOURCE: Buffer.from(source).toString('base64') }
  })
}

assert.equal(run(registry).status, 0, 'valid registry must pass')
assert.notEqual(run(registry.replace("owner: 'electron/confirmation'", "owner: ''")).status, 0, 'missing owner must fail')
assert.notEqual(run(registry.replace("'electron/confirmation/recursionGuard.test.ts'", "'electron/confirmation/missing.test.ts'")).status, 0, 'missing test reference must fail')
assert.notEqual(run(registry.replace("tests: ['electron/confirmation/recursionGuard.test.ts', 'electron/confirmation/toolCallGate.test.ts']", "tests: []")).status, 0, 'missing test list must fail')
console.log('[system-invariant-registry] valid and invalid fixtures passed')
