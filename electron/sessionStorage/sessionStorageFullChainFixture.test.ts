import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createFixtureDefinition } from '../../scripts/session-storage-full-chain-options.mjs'

describe('session storage full chain synthetic fixture', () => {
  it('generates deterministic, content-free scale metadata for a fixed seed', () => {
    const run = () => spawnSync(process.execPath, ['scripts/session-storage-full-chain-fixture.mjs', '--quick', '--seed', '41'], { encoding: 'utf8' })
    const first = run(); const second = run()
    expect(first.status).toBe(0)
    expect(JSON.parse(first.stdout).fixture).toEqual(JSON.parse(second.stdout).fixture)
    expect(first.stdout).not.toContain('xxxxxxxx')
    expect(JSON.parse(first.stdout).fixture.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'events', count: 100, bodyBytes: 409600 }),
      expect.objectContaining({ kind: 'turns', count: 100, pageSize: 20 })
    ]))
  }, 30_000)

  it('honors equals-form scenario and sample options before launching Electron', () => {
    const { fixture, runnerTimeoutMs } = createFixtureDefinition(['--only=cold-history', '--samples=1', '--seed=41', '--timeout-ms=60000'])
    expect(fixture.scenarios).toEqual([
      { kind: 'cold-history', count: 1, bodyBytes: 1024 * 1024 },
      { kind: 'cold-history', count: 10, bodyBytes: 10 * 1024 * 1024 },
      { kind: 'cold-history', count: 100, bodyBytes: 100 * 1024 * 1024 }
    ])
    expect(fixture.samples).toBe(1)
    expect(fixture.seed).toBe(41)
    expect(runnerTimeoutMs).toBe(60_000)
  })
})
