import type { AppDatabase } from '../database/sqliteStore'
import type { SessionStorage } from './contracts'
import { createSessionCommands } from './commands'
import { createSessionQueries } from './queries'
import { createSessionExecutionStore } from './execution'
import { createSessionStorageContextRouter } from './contextPortRegistry'
import { getSessionEventSink, readCompactionReplay } from '../sessionEvents'
import { createStorageSessionContextAdapter } from './contextAdapter'
import { createSqliteSessionRecoveryPort, type SessionRecoveryDependencies } from './recovery'
import { createStorageLifecycleControl } from './lifecycle'

/** SQLite composition root. Consumers receive bound ports and never receive the database handle. */
export function createSqliteSessionStorage(db: AppDatabase, options: {
  getTurnRuntime?: () => import('../turnRuntime').TurnRuntime
  getWorkDirForSession?: (sessionId: string) => string | undefined
  getUserDataDir?: () => string
  getSessionEventSink?: typeof getSessionEventSink
  readCompactionReplay?: typeof readCompactionReplay
  recoveryStages?: Partial<Pick<SessionRecoveryDependencies, 'history' | 'snapshots' | 'coordinator' | 'reconcile' | 'continuations' | 'ledgerRepairs'>>
} = {}): SessionStorage {
  const queries = createSessionQueries(db)
  const execution = createSessionExecutionStore(db, queries, options)
  const contexts = createSessionStorageContextRouter(async ({ sessionId, isBusy }) => {
    const session = queries.readSession(sessionId)
    const workDir = options.getWorkDirForSession?.(sessionId)
    const userDataDir = options.getUserDataDir?.()
    if (!session || !workDir || !userDataDir) throw new Error('SESSION_CONTEXT_RESOURCES_UNAVAILABLE')
    const sink = (options.getSessionEventSink ?? getSessionEventSink)(workDir, session.id, session.createdAt)
    const replay = await (options.readCompactionReplay ?? readCompactionReplay)(sink.eventsPath)
    return createStorageSessionContextAdapter({ sessionId, session, queries, workDir, userDataDir, replay, sink, isBusy })
  })
  const recovery = createSqliteSessionRecoveryPort({ db, queries, execution, getTurnRuntime: options.getTurnRuntime, stages: options.recoveryStages })
  return Object.freeze({ queries, commands: createSessionCommands(db), execution, contexts, recovery })
}

/** Host composition additionally binds existing startup recovery owners without exposing them to business consumers. */
export function createSqliteSessionStorageHost(db: AppDatabase, input: {
  storage: NonNullable<Parameters<typeof createSqliteSessionStorage>[1]>
  startup: import('./contracts').SessionStorageStartupCoordination
  maintenanceTasks?: Parameters<typeof createStorageLifecycleControl>[0]['tasks']
  quiesceMaintenance?: Parameters<typeof createStorageLifecycleControl>[0]['quiesce']
}) {
  const storage = createSqliteSessionStorage(db, {
    ...input.storage,
    recoveryStages: {
      ...input.storage.recoveryStages,
      history: input.startup.recoverHistory,
      ledgerRepairs: async () => (await input.startup.recoverSessionLedgers()).repairFailureCount
    }
  })
  const lifecycle = createStorageLifecycleControl({ tasks: input.maintenanceTasks ?? [], quiesce: input.quiesceMaintenance })
  return Object.freeze({ storage, startup: input.startup, lifecycle })
}
