import { defineDirectTool, definePlannedTool, TypedToolRegistry } from '../tools/plannedToolRegistry'

const fixtureToolNames = [
  'im_inbox_list', 'im_inbox_claim', 'im_inbox_ack', 'im_inbox_release', 'im_inbox_renew',
  'im_workflow_state_get', 'im_workflow_state_put', 'task_cancel', 'task_revise_plan'
] as const

/** Test-only registry shape: exercise IM invocation composition before production adapters land. */
export function createImTaskOrchestrationToolFixtureRegistry(): TypedToolRegistry {
  const registry = new TypedToolRegistry()
  for (const name of fixtureToolNames) {
    registry.register(defineDirectTool({
      name,
      parseInput: (value) => value as Record<string, unknown>,
      execute: async () => ({ success: true, fixture: true })
    }))
  }
  return registry
}

export function createScopedInboxFixtureTool(onExecute: (context: Record<string, unknown>) => void) {
  return definePlannedTool({
    name: 'im_inbox_claim',
    parseInput: (value) => value as Record<string, unknown>,
    plan: async (input, planning) => ({ input, runtime: { ...planning.executionContext } }),
    execute: async ({ input, runtime }) => {
      onExecute(runtime)
      return { success: true, input }
    }
  })
}
