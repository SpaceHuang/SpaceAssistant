import type { AppDatabase } from '../database'
import type { AppIpcContext } from '../appIpc'
import { createSessionTurnRuntime, createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

/** Test-only composition owner for fixtures backed by the production SQLite adapter. */
export function createTestSessionStorage(db: AppDatabase) {
  return createSqliteSessionStorage(db)
}

/** Supply mandatory session ports to focused IPC fixtures that exercise unrelated handlers. */
export function withSessionRuntime(ctx: AppIpcContext): AppIpcContext {
  const sessionStorage = ctx.sessionStorage ?? createSqliteSessionStorage(ctx.db)
  return {
    ...ctx,
    sessionStorage,
    turnRuntime: ctx.turnRuntime ?? createSessionTurnRuntime(sessionStorage, { deps: { now: () => 1, id: () => 'ipc-test-turn' } })
  }
}
