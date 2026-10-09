import type { AppDatabase } from '../database/sqliteStore'
import { TypedToolRegistry } from '../tools/plannedToolRegistry'
import { createImInboxListToolRegistry, createImInboxMutationToolRegistry } from './imInboxToolContext'
import { createImWorkflowStateToolRegistry } from './imWorkflowStateTools'
import { createImTaskControlToolRegistry } from './imTaskControlTools'
import type { ImTaskSafetyPort } from './imTaskControlCoordinator'

/** Production IM orchestration capabilities, scoped by the authenticated invocation context. */
export function createImOrchestrationToolRegistry(db: AppDatabase, taskSafetyPort: ImTaskSafetyPort): TypedToolRegistry {
  const registry = new TypedToolRegistry()
  for (const source of [createImInboxListToolRegistry(db), createImInboxMutationToolRegistry(db), createImWorkflowStateToolRegistry(db),
    createImTaskControlToolRegistry(db, taskSafetyPort)]) {
    for (const tool of source.entries()) registry.register(tool)
  }
  return registry
}
