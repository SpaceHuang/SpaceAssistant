import type { AppDatabase } from '../database/sqliteStore'
import { getWorkflowState, putWorkflowState } from '../database/workflowState'
import { defineDirectTool, TypedToolRegistry, type ToolExecutionContext } from '../tools/plannedToolRegistry'
import { bindImInboxToolContext, type AuthenticatedImToolContext } from './imInboxToolContext'

function workflowIdentity(context: ToolExecutionContext): { sessionId: string } {
  const runtime = (context as unknown as { runtimeContext?: Record<string, unknown> }).runtimeContext
  if (!runtime) throw new Error('IM_TOOL_CONTEXT_REQUIRED')
  const bound = bindImInboxToolContext({}, runtime as unknown as AuthenticatedImToolContext)
  return { sessionId: bound.sessionId }
}

function parseWorkflowId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('IM_WORKFLOW_ID_REQUIRED')
  return value.trim()
}

export function createImWorkflowStateToolRegistry(db: AppDatabase): TypedToolRegistry {
  const registry = new TypedToolRegistry()
  registry.register(defineDirectTool({
    name: 'im_workflow_state_get',
    parseInput: (value) => ({ workflowId: parseWorkflowId((value as { workflowId?: unknown } | null)?.workflowId) }),
    execute: async (input, context) => {
      const { sessionId } = workflowIdentity(context)
      return { success: true, state: getWorkflowState(db, { sessionId, workflowId: input.workflowId }) }
    }
  }))
  registry.register(defineDirectTool({
    name: 'im_workflow_state_put',
    parseInput: (value) => {
      const candidate = value as { workflowId?: unknown; expectedRevision?: unknown; data?: unknown } | null
      const expectedRevision = candidate?.expectedRevision
      if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0)) {
        throw new TypeError('IM_WORKFLOW_REVISION_INVALID')
      }
      const data = candidate?.data
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) {
        throw new TypeError('IM_WORKFLOW_DATA_INVALID')
      }
      return { workflowId: parseWorkflowId(candidate.workflowId), expectedRevision: expectedRevision as number | null, data: structuredClone(data as Record<string, unknown>) }
    },
    execute: async (input, context) => {
      const { sessionId } = workflowIdentity(context)
      const result = putWorkflowState(db, {
        sessionId, workflowId: input.workflowId, expectedRevision: input.expectedRevision, data: input.data
      })
      return result.ok ? { success: true, state: result.state } : { success: false, error: result.error, current: result.current }
    }
  }))
  return registry
}
