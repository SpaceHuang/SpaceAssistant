import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createStorageProfileFixture } from './storage-profile-perf-baseline-fixture'

const fixtures: Array<{ cleanup: () => void }> = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup() })

describe('session-storage-profile CLI', () => {
  it('keeps the legacy strict profile output and never prints fixture message bodies', () => {
    const fixture = createStorageProfileFixture('small'); fixtures.push(fixture)
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/session-storage-profile.ts', fixture.dbPath], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ tables: { messages: { rows: 100 } }, messageBodyCoverage: { messages: 100 } })
    expect(result.stdout).not.toContain('x'.repeat(fixture.spec.payloadBytes))
  })
})
