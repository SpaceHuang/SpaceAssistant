import { describe, expect, it } from 'vitest'
import { createFixtureDefinition } from '../../scripts/session-storage-full-chain-options.mjs'

describe('session storage full chain synthetic fixture', () => {
  it('generates deterministic, content-free scale metadata for a fixed seed', () => {
    const first = createFixtureDefinition(['--quick', '--seed', '41']).fixture
    const second = createFixtureDefinition(['--quick', '--seed', '41']).fixture
    const serialized = JSON.stringify(first)
    expect(first).toEqual(second)
    expect(serialized).not.toContain('xxxxxxxx')
    expect(first.scenarios).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'events', count: 100, bodyBytes: 409600 }),
      expect.objectContaining({ kind: 'turns', count: 100, pageSize: 20 })
    ]))
  })

  it('honors equals-form scenario and sample options before launching Electron', () => {
    const { fixture, runnerTimeoutMs } = createFixtureDefinition(['--only=cold-history', '--samples=1', '--seed=41', '--timeout-ms=60000'])
    expect(fixture.scenarios).toEqual([
      { kind: 'cold-history', scenarioId: 'cold-history-1', count: 1, bodyBytes: 1024 * 1024 },
      { kind: 'cold-history', scenarioId: 'cold-history-10', count: 10, bodyBytes: 10 * 1024 * 1024 },
      { kind: 'cold-history', scenarioId: 'cold-history-100', count: 100, bodyBytes: 100 * 1024 * 1024 }
    ])
    expect(fixture.samples).toBe(1)
    expect(fixture.seed).toBe(41)
    expect(runnerTimeoutMs).toBe(60_000)
  })
})
