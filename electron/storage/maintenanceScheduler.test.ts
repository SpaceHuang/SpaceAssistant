import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createMaintenanceScheduler, nextLocalDayBoundary, toLocalDayString } from './maintenanceScheduler'

describe('long lived maintenance owner scheduler', () => {
  const roots: string[] = []
  afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

  const watermark = async (name: string) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-scheduler-'))
    roots.push(root)
    return path.join(root, name)
  }

  it('calculates local calendar-day boundaries rather than adding 24 hours', () => {
    const value = new Date(2026, 9, 8, 23, 59, 30).getTime()
    expect(toLocalDayString(value)).toBe('2026-10-08')
    expect(nextLocalDayBoundary(value)).toBe(new Date(2026, 9, 9, 0, 0, 0, 0).getTime())
  })

  it('uses 23 and 25 hour calendar days across DST transitions', () => {
    const source = `const next=(t)=>{const d=new Date(t);return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1,0,0,0,0).getTime()};const spring=new Date(2026,2,8,12).getTime();const fall=new Date(2026,10,1,12).getTime();process.stdout.write(JSON.stringify([next(spring)-new Date(2026,2,8,0).getTime(),next(fall)-new Date(2026,10,1,0).getTime()]))`
    const values = JSON.parse(execFileSync(process.execPath, ['-e', source], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' })) as number[]
    expect(values).toEqual([23 * 60 * 60 * 1000, 25 * 60 * 60 * 1000])
  })

  it('runs again after crossing local midnight and after a policy fingerprint change', async () => {
    vi.useFakeTimers()
    let current = new Date(2026, 9, 8, 23, 59, 59).getTime()
    let policy = 'policy-v1'
    const watermarkPath = await watermark('calendar-policy.json')
    const run = vi.fn().mockResolvedValue({ success: true, scannedCount: 1, processedCount: 1 })
    const task = createMaintenanceScheduler({
      watermarkPath, policyFingerprint: () => policy, rootFingerprint: () => '/root', algorithmVersion: 1,
      now: () => current, run
    })
    const handle = task.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
    current = new Date(2026, 9, 9, 0, 0, 0).getTime()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    policy = 'policy-v2'
    handle.request?.('policy-changed')
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))
    handle.stop()
    await handle.quiesce()
  })

  it('quiesces on pause and resumes from the persisted watermark', async () => {
    vi.useFakeTimers()
    const watermarkPath = await watermark('pause-resume.json')
    const run = vi.fn().mockResolvedValue({ success: true, scannedCount: 1, processedCount: 1 })
    const task = createMaintenanceScheduler({
      watermarkPath, policyFingerprint: () => 'policy-v1', rootFingerprint: () => '/root', algorithmVersion: 1,
      now: () => new Date(2026, 9, 8, 12).getTime(), run
    })
    const handle = task.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    handle.stop()
    await handle.quiesce()
    const resumed = task.start()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    resumed.stop()
    await resumed.quiesce()
  })

  it('merges wakeups received during a sweep and runs the newly requested reason', async () => {
    vi.useFakeTimers()
    const watermarkPath = await watermark('wake.json')
    const firstFinish: Array<() => void> = []
    const run = vi.fn(({ reason }: { reason: string }) => new Promise<{ success: true; scannedCount: number; processedCount: number }>((resolve) => {
      firstFinish.push(() => resolve({ success: true, scannedCount: 1, processedCount: reason === 'capacity-pressure' ? 2 : 1 }))
    }))
    const task = createMaintenanceScheduler({
      watermarkPath, policyFingerprint: () => 'policy-v1', rootFingerprint: () => '/root', algorithmVersion: 1,
      now: () => new Date(2026, 9, 8, 12).getTime(), run
    })
    const handle = task.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run).toHaveBeenCalledTimes(1)
    handle.request?.('capacity-pressure')
    firstFinish.shift()?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run).toHaveBeenCalledTimes(2)
    firstFinish.shift()?.()
    handle.stop()
    await handle.quiesce()
  })

  it('schedules the next local date after success and retry after failure', async () => {
    vi.useFakeTimers()
    const watermarkPath = await watermark('retry.json')
    const run = vi.fn().mockResolvedValueOnce({ success: false, scannedCount: 0, processedCount: 0, errorCode: 'EACCES' })
      .mockResolvedValue({ success: true, scannedCount: 2, processedCount: 2 })
    const task = createMaintenanceScheduler({
      watermarkPath, policyFingerprint: () => 'policy-v1', rootFingerprint: () => '/root', algorithmVersion: 1,
      now: () => new Date(2026, 9, 8, 12).getTime(), retryDelayMs: 500, run
    })
    const handle = task.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run).toHaveBeenCalledTimes(2)
    handle.stop()
    await handle.quiesce()
  })
})
