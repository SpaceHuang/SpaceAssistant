import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { StorageProfileCoordinator } from './storageProfileCoordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const result = (type: 'overview' | 'audit', label: string) => ({ type, result: { label } } as any)

describe('StorageProfileCoordinator', () => {
  it('normalizes database identity and single-flights matching requests only', async () => {
    const first = deferred<any>()
    const second = deferred<any>()
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const coordinator = new StorageProfileCoordinator({ run })
    const dbPath = path.join(os.tmpdir(), 'storage-profile-id', 'data.db')
    const a = coordinator.request({ dbPath, type: 'overview' })
    const b = coordinator.request({ dbPath: path.join(os.tmpdir(), 'storage-profile-id', '.', 'data.db'), type: 'overview' })
    const audit = coordinator.request({ dbPath, type: 'audit' })
    expect(run).toHaveBeenCalledTimes(1)
    first.resolve(result('overview', 'ok'))
    await expect(a).resolves.toEqual(result('overview', 'ok'))
    await expect(b).resolves.toEqual(result('overview', 'ok'))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    second.resolve(result('audit', 'audit'))
    await expect(audit).resolves.toEqual(result('audit', 'audit'))
  })

  it('uses cache normally, bypasses completed cache on force, and reuses same-generation in-flight work', async () => {
    const calls: Array<ReturnType<typeof deferred<any>>> = []
    const coordinator = new StorageProfileCoordinator({ run: vi.fn(() => { const next = deferred<any>(); calls.push(next); return next.promise }) })
    const dbPath = '/tmp/profile-cache.db'
    const initial = coordinator.request({ dbPath, type: 'overview' })
    calls[0]!.resolve(result('overview', 'one'))
    await initial
    await expect(coordinator.request({ dbPath, type: 'overview' })).resolves.toEqual(result('overview', 'one'))
    const forcedA = coordinator.request({ dbPath, type: 'overview', force: true })
    const forcedB = coordinator.request({ dbPath, type: 'overview', force: true })
    expect(calls).toHaveLength(2)
    calls[1]!.resolve(result('overview', 'two'))
    await expect(forcedA).resolves.toEqual(result('overview', 'two'))
    await expect(forcedB).resolves.toEqual(result('overview', 'two'))
  })

  it('fences stale generation writes and forces maintenance refresh to start a new reader', async () => {
    const calls: Array<ReturnType<typeof deferred<any>>> = []
    const coordinator = new StorageProfileCoordinator({ run: vi.fn(() => { const next = deferred<any>(); calls.push(next); return next.promise }) })
    const dbPath = '/tmp/profile-generation.db'
    const old = coordinator.request({ dbPath, type: 'overview' })
    calls[0]!.resolve(result('overview', 'old-snapshot'))
    await old
    await coordinator.withMaintenance(dbPath, async () => undefined)
    const fresh = coordinator.request({ dbPath, type: 'overview', force: true })
    expect(calls).toHaveLength(2)
    calls[1]!.resolve(result('overview', 'fresh'))
    await expect(fresh).resolves.toEqual(result('overview', 'fresh'))
    await expect(coordinator.request({ dbPath, type: 'overview' })).resolves.toEqual(result('overview', 'fresh'))
  })

  it('bounds global and per-database workers, queues overview ahead, and eventually services audit', async () => {
    const calls: Array<{ request: any; job: ReturnType<typeof deferred<any>> }> = []
    const coordinator = new StorageProfileCoordinator({ maxWorkers: 2, maxWorkersPerDatabase: 1, maxQueue: 3,
      run: vi.fn((request: any) => { const job = deferred<any>(); calls.push({ request, job }); return job.promise }) })
    const db1 = '/tmp/profile-limit-1.db'
    const db2 = '/tmp/profile-limit-2.db'
    const db3 = '/tmp/profile-limit-3.db'
    const first = coordinator.request({ dbPath: db1, type: 'audit' })
    const second = coordinator.request({ dbPath: db2, type: 'audit' })
    const queuedOverview = coordinator.request({ dbPath: db1, type: 'overview' })
    const queuedAudit = coordinator.request({ dbPath: db3, type: 'audit' })
    expect(calls).toHaveLength(2)
    calls[0]!.job.resolve(result('audit', 'a1'))
    await first
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2]!.request.type).toBe('overview')
    calls[2]!.job.resolve(result('overview', 'o1'))
    await queuedOverview
    calls[1]!.job.resolve(result('audit', 'a2'))
    await second
    await vi.waitFor(() => expect(calls).toHaveLength(4))
    calls[3]!.job.resolve(result('audit', 'a3'))
    await queuedAudit
    await vi.waitFor(() => expect(coordinator.activeWorkerCount).toBe(0))
  })

  it('releases task records and concurrency permits after worker rejection', async () => {
    const coordinator = new StorageProfileCoordinator({ run: vi.fn().mockRejectedValue(new Error('worker failed')) })
    await expect(coordinator.request({ dbPath: '/tmp/profile-fail.db', type: 'overview' })).rejects.toThrow('worker failed')
    expect(coordinator.activeWorkerCount).toBe(0)
    expect(coordinator.inFlightTaskCount).toBe(0)
  })

  it('settles synchronous worker startup failures and releases admission for retry, maintenance, and shutdown', async () => {
    const run = vi.fn().mockImplementationOnce(() => { throw new Error('missing worker entry') })
      .mockResolvedValue(result('overview', 'retry-ok'))
    const coordinator = new StorageProfileCoordinator({ run })
    const dbPath = '/tmp/profile-sync-start-failure.db'
    await expect(Promise.resolve().then(() => coordinator.request({ dbPath, type: 'overview' })))
      .rejects.toThrow('missing worker entry')
    await vi.waitFor(() => {
      expect(coordinator.activeWorkerCount).toBe(0)
      expect(coordinator.inFlightTaskCount).toBe(0)
    })
    await expect(coordinator.request({ dbPath, type: 'overview', force: true })).resolves.toEqual(result('overview', 'retry-ok'))
    await expect(coordinator.withMaintenance(dbPath, async () => 'maintenance-ok')).resolves.toBe('maintenance-ok')
    await expect(coordinator.shutdown({ deadlineMs: 100 })).resolves.toEqual({ status: 'quiescent' })
  })

  it('closes admission, aborts and drains readers before maintenance, and rejects a competing lease', async () => {
    const reader = deferred<any>()
    const started = deferred<void>()
    const run = vi.fn(() => { started.resolve(); return reader.promise })
    const coordinator = new StorageProfileCoordinator({ run })
    const dbPath = '/tmp/profile-maintenance-gate.db'
    const pendingReader = coordinator.request({ dbPath, type: 'overview' })
    await started.promise
    const operation = deferred<void>()
    let maintenanceStarted = false
    const maintenance = coordinator.withMaintenance(dbPath, async () => { maintenanceStarted = true; await operation.promise })
    await expect(coordinator.request({ dbPath, type: 'audit' })).rejects.toThrow('STORAGE_PROFILE_MAINTENANCE_BUSY')
    await expect(coordinator.withMaintenance(dbPath, async () => undefined)).rejects.toThrow('STORAGE_PROFILE_MAINTENANCE_BUSY')
    expect(maintenanceStarted).toBe(false)
    reader.resolve(result('overview', 'drained'))
    await pendingReader
    await vi.waitFor(() => expect(maintenanceStarted).toBe(true))
    operation.resolve()
    await maintenance
    expect(coordinator.activeWorkerCount).toBe(0)
    await expect(coordinator.request({ dbPath, type: 'overview' })).resolves.toEqual(result('overview', 'drained'))
  })

  it('rejects cached and in-flight reads as soon as a maintenance lease is acquired', async () => {
    const run = vi.fn().mockResolvedValue(result('overview', 'cached'))
    const coordinator = new StorageProfileCoordinator({ run })
    const dbPath = '/tmp/profile-maintenance-cache.db'
    await coordinator.request({ dbPath, type: 'overview' })
    const gate = deferred<void>()
    const maintenance = coordinator.withMaintenance(dbPath, () => gate.promise)
    await expect(coordinator.request({ dbPath, type: 'overview' })).rejects.toThrow('STORAGE_PROFILE_MAINTENANCE_BUSY')
    await expect(coordinator.request({ dbPath, type: 'overview', force: true })).rejects.toThrow('STORAGE_PROFILE_MAINTENANCE_BUSY')
    gate.resolve()
    await maintenance
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('marks cache dirty after a maintenance error that may have partially written', async () => {
    const run = vi.fn().mockResolvedValueOnce(result('overview', 'before')).mockResolvedValueOnce(result('overview', 'after'))
    const coordinator = new StorageProfileCoordinator({ run })
    const dbPath = '/tmp/profile-maintenance-failure.db'
    await coordinator.request({ dbPath, type: 'overview' })
    await expect(coordinator.withMaintenance(dbPath, async () => { throw new Error('partial write') })).rejects.toThrow('partial write')
    await expect(coordinator.request({ dbPath, type: 'overview' })).resolves.toEqual(result('overview', 'after'))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('stops admission on shutdown, rejects queued tasks, and waits for active task settlement', async () => {
    const running = deferred<any>()
    const started = deferred<void>()
    const run = vi.fn(() => { started.resolve(); return running.promise })
    const coordinator = new StorageProfileCoordinator({ maxWorkers: 1, maxQueue: 2, run })
    const active = coordinator.request({ dbPath: '/tmp/profile-shutdown-1.db', type: 'overview' })
    await started.promise
    const queued = coordinator.request({ dbPath: '/tmp/profile-shutdown-2.db', type: 'audit' })
    const shutdown = coordinator.shutdown({ deadlineMs: 1_000 })
    await expect(queued).rejects.toThrow('STORAGE_PROFILE_SHUTTING_DOWN')
    await expect(coordinator.request({ dbPath: '/tmp/profile-shutdown-3.db', type: 'overview' })).rejects.toThrow('STORAGE_PROFILE_SHUTTING_DOWN')
    running.resolve(result('overview', 'closed'))
    await active
    await expect(shutdown).resolves.toEqual({ status: 'quiescent' })
    expect(coordinator.activeWorkerCount).toBe(0)
  })

  it('waits for a maintenance lease already in progress without releasing it on shutdown', async () => {
    const operation = deferred<void>()
    const coordinator = new StorageProfileCoordinator({ run: async () => result('overview', 'unused') })
    const maintenance = coordinator.withMaintenance('/tmp/profile-shutdown-maintenance.db', () => operation.promise)
    await vi.waitFor(() => expect(coordinator.inFlightTaskCount).toBe(0))
    const shutdown = coordinator.shutdown({ deadlineMs: 1_000 })
    await expect(coordinator.request({ dbPath: '/tmp/profile-shutdown-maintenance.db', type: 'overview' })).rejects.toThrow('STORAGE_PROFILE_SHUTTING_DOWN')
    expect(coordinator.isMaintenanceActive('/tmp/profile-shutdown-maintenance.db')).toBe(true)
    operation.resolve()
    await maintenance
    await expect(shutdown).resolves.toEqual({ status: 'quiescent' })
    expect(coordinator.isMaintenanceActive('/tmp/profile-shutdown-maintenance.db')).toBe(false)
  })

  it('reports deadline exceeded while a worker is still alive and never reopens admission', async () => {
    const running = deferred<any>()
    const coordinator = new StorageProfileCoordinator({ run: async () => running.promise })
    const active = coordinator.request({ dbPath: '/tmp/profile-shutdown-timeout.db', type: 'overview' })
    await expect(coordinator.shutdown({ deadlineMs: 5 })).resolves.toEqual({ status: 'deadline-exceeded' })
    expect(coordinator.activeWorkerCount).toBe(1)
    await expect(coordinator.request({ dbPath: '/tmp/profile-shutdown-timeout.db', type: 'overview' })).rejects.toThrow('STORAGE_PROFILE_SHUTTING_DOWN')
    running.resolve(result('overview', 'late'))
    await active
    await vi.waitFor(() => expect(coordinator.activeWorkerCount).toBe(0))
  })
})
