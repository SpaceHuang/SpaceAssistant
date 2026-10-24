import { assembleInvocation as assembleInvocationWithPorts } from '../runtime/invocationAssembler'
import type { AgentInvocationMaterials } from '../runtime/invocationAssembler'
import type { AppDatabase } from '../database'
import { createTestSessionStorage } from './sessionStorageComposition'

/** Test composition helper: supply the SQLite ports for fixtures that own an AppDatabase. */
export function assembleInvocation(materials: AgentInvocationMaterials) {
  const db = materials.appDb as AppDatabase | undefined
  const sessionStorage = materials.sessionStorage ?? (db ? createTestSessionStorage(db) : undefined)
  return assembleInvocationWithPorts({ ...materials, ...(sessionStorage ? { sessionStorage } : {}) })
}
