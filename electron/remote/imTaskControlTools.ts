import type { AppDatabase } from '../database/sqliteStore'
import type { RemoteContext } from '../tools/types'
import { defineDirectTool, TypedToolRegistry, type ToolExecutionContext } from '../tools/plannedToolRegistry'
import { bindImInboxToolContext, type AuthenticatedImToolContext } from './imInboxToolContext'
import { createImTaskControlCoordinator, type ImTaskSafetyPort } from './imTaskControlCoordinator'

type TaskRuntimeContext = AuthenticatedImToolContext & { remoteContext: RemoteContext }

function trustedTaskContext(context: ToolExecutionContext) {
  const runtime = (context as unknown as { runtimeContext?: Record<string, unknown> }).runtimeContext
  if (!runtime) throw new Error('IM_TOOL_CONTEXT_REQUIRED')
  const bound = bindImInboxToolContext({}, runtime as unknown as TaskRuntimeContext)
  return { sessionId: bound.sessionId, ownerId: bound.ownerId }
}

export function createImTaskControlToolRegistry(db: AppDatabase, safetyPort: ImTaskSafetyPort): TypedToolRegistry {
  const coordinator = createImTaskControlCoordinator({ db, safetyPort })
  const registry = new TypedToolRegistry()
  registry.register(defineDirectTool({
    name: 'task_cancel',
    actionClass: 'execute',
    parseInput: (value) => {
      const input = value as { workflowId: string; taskId: string; expectedRevision: number }
      return { workflowId: input.workflowId, taskId: input.taskId, expectedRevision: input.expectedRevision }
    },
    execute: async (input, context) => ({
      success: true,
      ...await coordinator.cancel({ ...trustedTaskContext(context), ...input })
    })
  }))
  registry.register(defineDirectTool({
    name: 'task_revise_plan',
    actionClass: 'execute',
    parseInput: (value) => {
      const input = value as {
        workflowId: string; taskId: string; expectedRevision: number; newRevision: number
        newSteps: Array<{ stepId: string; instruction: string }>
        stepMapping: Array<{ fromStepId: string; toStepId: string }>
      }
      return {
        workflowId: input.workflowId, taskId: input.taskId, expectedRevision: input.expectedRevision,
        newRevision: input.newRevision, newSteps: input.newSteps, stepMapping: input.stepMapping
      }
    },
    execute: async (input, context) => ({
      success: true,
      ...await coordinator.revisePlan({ ...trustedTaskContext(context), ...input })
    })
  }))
  return registry
}
