import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createStorageProfileFixture, getStorageProfileFixtureSpec, STORAGE_PROFILE_FIXTURE_SEED, STORAGE_PROFILE_FIXTURE_VERSION } from '../../scripts/storage-profile-perf-baseline-fixture'

const fixtures: Array<{ cleanup: () => void }> = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup() })

describe('storage profile performance fixture', () => {
  it('pins versioned small, medium, and large row/payload/file shapes', () => {
    expect(getStorageProfileFixtureSpec('small')).toMatchObject({ version: 1, seed: 20261010, rows: 100, payloadBytes: 256, spillFiles: 10, indexState: 'missing' })
    expect(getStorageProfileFixtureSpec('medium')).toMatchObject({ rows: 2_000, payloadBytes: 1_024, spillFiles: 200 })
    expect(getStorageProfileFixtureSpec('large')).toMatchObject({ rows: 20_000, payloadBytes: 4_096, spillFiles: 2_000 })
    expect(STORAGE_PROFILE_FIXTURE_VERSION).toBe(1)
    expect(STORAGE_PROFILE_FIXTURE_SEED).toBe(20261010)
  })

  it('builds deterministic SQLite and spill fixtures without content in its descriptor', () => {
    const first = createStorageProfileFixture('small'); fixtures.push(first)
    const second = createStorageProfileFixture('small'); fixtures.push(second)
    expect(first.spec).toEqual(second.spec)
    expect(fs.statSync(first.dbPath).size).toBe(fs.statSync(second.dbPath).size)
    expect(fs.readdirSync(`${first.root}/spill`)).toHaveLength(10)
    expect(fs.readdirSync(`${second.root}/spill`)).toHaveLength(10)
    expect(JSON.stringify(first.spec)).not.toMatch(/private|fixture-\d|m-\d|\/[A-Za-z]/)
  })
})
