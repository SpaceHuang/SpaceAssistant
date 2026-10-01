import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('check-agent-sdk-dependencies', () => {
  it('rejects a shared-to-sdk dependency', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-sdk-boundary-'))
    try {
      mkdirSync(path.join(root, 'scripts'), { recursive: true })
      mkdirSync(path.join(root, 'src/shared'), { recursive: true })
      mkdirSync(path.join(root, 'packages/agent-sdk/src'), { recursive: true })
      const script = path.resolve('scripts/check-agent-sdk-dependencies.mjs')
      const source = readFileSync(script, 'utf8').replace(
        "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')",
        `const root = ${JSON.stringify(root)}`
      )
      writeFileSync(path.join(root, 'scripts/check-agent-sdk-dependencies.mjs'), source)
      writeFileSync(path.join(root, 'src/shared/leak.ts'), "export type { ApprovalStatus } from '../../packages/agent-sdk/src/approval'\n")
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-agent-sdk-dependencies.mjs')], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('src/shared 不得依赖 Agent SDK')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
