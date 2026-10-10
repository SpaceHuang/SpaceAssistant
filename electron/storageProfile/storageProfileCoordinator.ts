import path from 'node:path'
import { realpathSync } from 'node:fs'
import type { StorageAudit, StorageOverview } from '../../src/shared/storageTypes'

export type StorageProfileTaskType = 'overview' | 'audit'
export type StorageProfileRequest = Readonly<{ dbPath: string; type: StorageProfileTaskType; force?: boolean }>
export type StorageProfileResult = Readonly<{ type: StorageProfileTaskType; result: StorageOverview | StorageAudit }>
type RunWorker = (request: StorageProfileRequest, options: { signal: AbortSignal; generation: number }) => Promise<StorageProfileResult>
type Task = { key: string; identity: string; type: StorageProfileTaskType; generation: number; request: StorageProfileRequest; controller: AbortController; promise: Promise<StorageProfileResult>; resolve: (result: StorageProfileResult) => void; reject: (error: unknown) => void; started: boolean }

export type StorageProfileCoordinatorOptions = Readonly<{
  run: RunWorker
  maxWorkers?: number
  maxWorkersPerDatabase?: number
  maxQueue?: number
}>

export class StorageProfileCoordinator {
  private readonly runWorker: RunWorker
  private readonly maxWorkers: number
  private readonly maxWorkersPerDatabase: number
  private readonly maxQueue: number
  private readonly generations = new Map<string, number>()
  private readonly cache = new Map<string, StorageProfileResult>()
  private readonly tasks = new Map<string, Task>()
  private readonly queue: Task[] = []
  private readonly activeByDatabase = new Map<string, number>()
  private active = 0
  private readonly maintenanceByDatabase = new Map<string, symbol>()
  private readonly maintenanceOperations = new Set<Promise<unknown>>()
  private closed = false

  constructor(options: StorageProfileCoordinatorOptions) {
    this.runWorker = options.run
    this.maxWorkers = options.maxWorkers ?? 3
    this.maxWorkersPerDatabase = options.maxWorkersPerDatabase ?? 1
    this.maxQueue = options.maxQueue ?? 16
  }

  get activeWorkerCount() { return this.active }
  get inFlightTaskCount() { return this.tasks.size }
  isMaintenanceActive(dbPath: string) { return this.maintenanceByDatabase.has(normalizeDatabaseIdentity(dbPath)) }

  request(request: StorageProfileRequest): Promise<StorageProfileResult> {
    if (this.closed) return Promise.reject(new Error('STORAGE_PROFILE_SHUTTING_DOWN'))
    const identity = normalizeDatabaseIdentity(request.dbPath)
    if (this.maintenanceByDatabase.has(identity)) return Promise.reject(new Error('STORAGE_PROFILE_MAINTENANCE_BUSY'))
    const generation = this.generations.get(identity) ?? 0
    const key = taskKey(identity, request.type, generation)
    const inFlight = this.tasks.get(key)
    if (inFlight) return inFlight.promise
    if (!request.force) {
      const cached = this.cache.get(key)
      if (cached) return Promise.resolve(cached)
    }
    const task = this.makeTask(key, identity, generation, request)
    const canStart = this.active < this.maxWorkers && (this.activeByDatabase.get(identity) ?? 0) < this.maxWorkersPerDatabase
    if (canStart && this.queue.length === 0) this.start(task)
    else {
      if (this.queue.length >= this.maxQueue) { this.tasks.delete(key); task.reject(new Error('STORAGE_PROFILE_QUEUE_FULL')) }
      else { this.queue.push(task); this.sortQueue() }
    }
    return task.promise
  }

  /** Bump cache generation after a caller has drained readers and completed maintenance. */
  withMaintenance<T>(dbPath: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('STORAGE_PROFILE_SHUTTING_DOWN'))
    const identity = normalizeDatabaseIdentity(dbPath)
    if (this.maintenanceByDatabase.has(identity)) return Promise.reject(new Error('STORAGE_PROFILE_MAINTENANCE_BUSY'))
    const lease = Symbol('storage-profile-maintenance-lease')
    this.maintenanceByDatabase.set(identity, lease)
    const pending = this.runMaintenance(identity, lease, operation)
    this.maintenanceOperations.add(pending)
    void pending.finally(() => this.maintenanceOperations.delete(pending)).catch(() => undefined)
    return pending
  }

  private async runMaintenance<T>(identity: string, lease: symbol, operation: () => Promise<T>): Promise<T> {
    const readers = [...this.tasks.values()].filter((task) => task.identity === identity)
    for (const task of readers) {
      if (!task.started) {
        this.queue.splice(this.queue.indexOf(task), 1)
        this.tasks.delete(task.key)
        task.reject(new Error('STORAGE_PROFILE_MAINTENANCE_BUSY'))
      } else task.controller.abort()
    }
    await Promise.allSettled(readers.filter((task) => task.started).map((task) => task.promise))
    try {
      const value = await operation()
      this.generations.set(identity, (this.generations.get(identity) ?? 0) + 1)
      this.invalidate(identity)
      return value
    } catch (error) {
      // Maintenance may have partially written before failing; fence and discard old snapshots.
      this.generations.set(identity, (this.generations.get(identity) ?? 0) + 1)
      this.invalidate(identity)
      throw error
    } finally {
      if (this.maintenanceByDatabase.get(identity) === lease) this.maintenanceByDatabase.delete(identity)
      this.pump()
    }
  }

  async shutdown(options: { deadlineMs: number }): Promise<{ status: 'quiescent' | 'deadline-exceeded' }> {
    this.closed = true
    for (const task of [...this.queue]) {
      this.queue.splice(this.queue.indexOf(task), 1)
      this.tasks.delete(task.key)
      task.reject(new Error('STORAGE_PROFILE_SHUTTING_DOWN'))
    }
    const activeTasks = [...this.tasks.values()].filter((task) => task.started)
    for (const task of activeTasks) task.controller.abort()
    const drained = Promise.allSettled([...activeTasks.map((task) => task.promise), ...this.maintenanceOperations]).then(() => ({ status: 'quiescent' as const }))
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<{ status: 'deadline-exceeded' }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: 'deadline-exceeded' }), Math.max(0, options.deadlineMs))
    })
    const result = await Promise.race([drained, deadline])
    if (timeout) clearTimeout(timeout)
    return result
  }

  private makeTask(key: string, identity: string, generation: number, _request: StorageProfileRequest): Task {
    let resolve!: (result: StorageProfileResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<StorageProfileResult>((res, rej) => { resolve = res; reject = rej })
    const task: Task = { key, identity, type: _request.type, generation, request: _request, controller: new AbortController(), promise, resolve, reject, started: false }
    this.tasks.set(key, task)
    return task
  }

  private start(task: Task) {
    if (task.started) return
    task.started = true
    this.active += 1
    this.activeByDatabase.set(task.identity, (this.activeByDatabase.get(task.identity) ?? 0) + 1)
    let workerRun: Promise<StorageProfileResult>
    try {
      workerRun = Promise.resolve(this.runWorker(task.request, { signal: task.controller.signal, generation: task.generation }))
    } catch (error) {
      workerRun = Promise.reject(error)
    }
    void workerRun.then((result) => {
      if ((this.generations.get(task.identity) ?? 0) === task.generation) this.cache.set(task.key, result)
      task.resolve(result)
    }, (error) => task.reject(error)).finally(() => {
      this.tasks.delete(task.key)
      this.active -= 1
      const count = (this.activeByDatabase.get(task.identity) ?? 1) - 1
      if (count <= 0) this.activeByDatabase.delete(task.identity)
      else this.activeByDatabase.set(task.identity, count)
      this.pump()
    })
  }

  private sortQueue() { this.queue.sort((left, right) => (left.type === right.type ? 0 : left.type === 'overview' ? -1 : 1)) }

  private pump() {
    let progressed = true
    while (progressed && this.active < this.maxWorkers) {
      progressed = false
      this.sortQueue()
      const index = this.queue.findIndex((task) => !this.maintenanceByDatabase.has(task.identity) &&
        (this.activeByDatabase.get(task.identity) ?? 0) < this.maxWorkersPerDatabase)
      if (index >= 0) {
        const [task] = this.queue.splice(index, 1)
        if (task) { this.start(task); progressed = true }
      }
    }
  }

  private invalidate(identity: string) {
    for (const key of this.cache.keys()) if (key.startsWith(`${identity}\0`)) this.cache.delete(key)
  }
}

function taskKey(identity: string, type: StorageProfileTaskType, generation: number) { return `${identity}\0${type}\0${generation}` }

export function normalizeDatabaseIdentity(dbPath: string): string {
  const resolved = path.resolve(dbPath)
  try { return realpathSync.native(resolved) } catch { return resolved }
}
