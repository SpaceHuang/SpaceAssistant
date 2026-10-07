import { assembleInvocation as assembleInvocationWithPorts } from '../runtime/invocationAssembler'
import type { AgentInvocationMaterials } from '../runtime/invocationAssembler'
import type { AppDatabase } from '../database'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

/** Test composition helper: supply the SQLite ports for fixtures that own an AppDatabase. */
export function assembleInvocation(materials: AgentInvocationMaterials) {
  const db = materials.appDb as AppDatabase | undefined
  const sessionStorage = materials.sessionStorage ?? (db ? createSqliteSessionStorage(db) : undefined)
  return assembleInvocationWithPorts({ ...materials, ...(sessionStorage ? { sessionStorage } : {}) })
}
