import type { AppDatabase } from '../database/sqliteStore'
import {
  SessionProjectionMigrationCoordinator,
  type SessionProjectionMigrationCoordinatorOptions,
  type SessionProjectionMigrationCoordinatorRunOptions,
  type SessionProjectionMigrationCoordinatorScheduleOptions,
} from './sessionProjectionMigrationCoordinator'
import type { SessionProjectionMigrationExecutionReport, SessionProjectionMigrationRun } from './sessionProjectionMigration'

/** Main-process lifecycle owner. It deliberately does not create or schedule a run during initialization. */
export class SessionProjectionMigrationApplication {
  private readonly coordinator: SessionProjectionMigrationCoordinator
  private readonly stops = new Set<() => void>()
  private initialized = false

  constructor(db: AppDatabase, options: SessionProjectionMigrationCoordinatorOptions = {}) {
    this.coordinator = new SessionProjectionMigrationCoordinator(db, options)
  }

  initialize(): void {
    this.initialized = true
  }

  async start(options: SessionProjectionMigrationCoordinatorRunOptions = {}): Promise<SessionProjectionMigrationExecutionReport> {
    this.assertInitialized()
    return this.coordinator.start(options)
  }

  createRun(options: Pick<SessionProjectionMigrationCoordinatorRunOptions, 'runId' | 'knownSessionIds' | 'now'> = {}): SessionProjectionMigrationRun {
    this.assertInitialized()
    return this.coordinator.createRun(options)
  }

  schedule(runId: string, options: SessionProjectionMigrationCoordinatorScheduleOptions = {}): () => void {
    this.assertInitialized()
    const stop = this.coordinator.schedule(runId, options)
    this.stops.add(stop)
    return () => {
      stop()
      this.stops.delete(stop)
    }
  }

  pause(runId: string): SessionProjectionMigrationRun {
    this.assertInitialized()
    return this.coordinator.pause(runId)
  }

  resume(runId: string): SessionProjectionMigrationRun {
    this.assertInitialized()
    return this.coordinator.resume(runId)
  }

  cancel(runId: string): SessionProjectionMigrationRun {
    this.assertInitialized()
    return this.coordinator.cancel(runId)
  }

  async shutdown(): Promise<void> {
    this.initialized = false
    for (const stop of this.stops) stop()
    this.stops.clear()
    await this.coordinator.shutdown()
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('session projection migration application is not initialized')
  }
}
