import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importsFrom, isAgentSdkSpecifier, scanSharedDependencies } from './check-agent-sdk-dependencies.mjs'

test('finds static, type-only, re-export, and dynamic SDK dependencies', () => {
  const source = `
    import type { Turn } from '../../../packages/agent-sdk/src/turn'
    export { createTurn } from "../../../packages/agent-sdk/src/turn"
    type Runtime = import('../../../packages/agent-sdk/src/runtime').Runtime
    const sdk = require('../../../packages/agent-sdk/src/index')
    import('../../../packages/agent-sdk/src/provider')
  `

  const imports = importsFrom(source)
  assert.equal(imports.length, 5)
  assert.ok(imports.every(isAgentSdkSpecifier))
})

test('does not treat comments and ordinary strings as dependencies', () => {
  const source = `
    // import { Turn } from '../../../packages/agent-sdk/src/turn'
    const example = "require('../../../packages/agent-sdk')"
  `

  assert.deepEqual(importsFrom(source), [])
})

test('matches package path segments and the public package name exactly', () => {
  assert.equal(isAgentSdkSpecifier('@spaceassistant/agent-sdk'), true)
  assert.equal(isAgentSdkSpecifier('../../../packages/agent-sdk/src/turn'), true)
  assert.equal(isAgentSdkSpecifier('../../../packages/agent-sdk-extra/src/turn'), false)
  assert.equal(isAgentSdkSpecifier('packages/not-agent-sdk/src/turn'), false)
})

test('checks production shared modules while excluding colocated and __tests__ files', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const shared = path.join(root, 'src', 'shared')
  mkdirSync(path.join(shared, '__tests__'), { recursive: true })
  writeFileSync(path.join(shared, 'domain.ts'), "import type { Turn } from '../../../packages/agent-sdk/src/turn'\n")
  writeFileSync(path.join(shared, 'domain.test.ts'), "import type { Turn } from '../../../packages/agent-sdk/src/turn'\n")
  writeFileSync(path.join(shared, '__tests__', 'domain.ts'), "import type { Turn } from '../../../packages/agent-sdk/src/turn'\n")

  assert.deepEqual(scanSharedDependencies(shared, root), [
    'src/shared/domain.ts: src/shared 不得依赖 Agent SDK (../../../packages/agent-sdk/src/turn)'
  ])
})
