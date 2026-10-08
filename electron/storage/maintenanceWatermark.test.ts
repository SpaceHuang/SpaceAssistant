import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readMaintenanceWatermark, recordMaintenanceFailure, recordMaintenanceSuccess, shouldRunMaintenance } from './maintenanceWatermark'

describe('private maintenance watermarks', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

  it('skips an unchanged local day and fingerprints policy and root changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-watermark-'))
    roots.push(root)
    const file = path.join(root, 'cleanup.json')
    const policy = { localDay: '2026-10-08', policyFingerprint: 'ttl-7-v1', rootFingerprint: '/tmp/a', algorithmVersion: 1 }
    expect(await shouldRunMaintenance(file, policy)).toBe(true)
    await recordMaintenanceSuccess(file, policy, 1_000)
    expect(await shouldRunMaintenance(file, policy)).toBe(false)
    expect(await shouldRunMaintenance(file, { ...policy, policyFingerprint: 'ttl-8-v1' })).toBe(true)
    expect(await shouldRunMaintenance(file, { ...policy, rootFingerprint: '/tmp/b' })).toBe(true)
    expect(await shouldRunMaintenance(file, { ...policy, localDay: '2026-10-09' })).toBe(true)
  })

  it('keeps the previous success waterline after failure and retries instead of skipping', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-watermark-fail-'))
    roots.push(root)
    const file = path.join(root, 'cleanup.json')
    const input = { localDay: '2026-10-08', policyFingerprint: 'v1', rootFingerprint: '/tmp/a', algorithmVersion: 1 }
    await recordMaintenanceSuccess(file, input, 1_000)
    await recordMaintenanceFailure(file, input, 'EACCES', 2_000)
    expect(await shouldRunMaintenance(file, input)).toBe(true)
    expect(await readMaintenanceWatermark(file)).toMatchObject({ lastSuccessDay: '2026-10-08', lastError: 'EACCES' })
  })

  it('treats missing or malformed files as rebuild-required', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-watermark-corrupt-'))
    roots.push(root)
    const file = path.join(root, 'cleanup.json')
    const input = { localDay: '2026-10-08', policyFingerprint: 'v1', rootFingerprint: '/tmp/a', algorithmVersion: 1 }
    expect(await shouldRunMaintenance(file, input)).toBe(true)
    await fs.writeFile(file, '{broken')
    expect(await shouldRunMaintenance(file, input)).toBe(true)
  })
})
