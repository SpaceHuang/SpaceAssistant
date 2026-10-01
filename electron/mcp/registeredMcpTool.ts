import { defineDirectTool } from '../tools/plannedToolRegistry'
import type { ToolExecutor, ToolExecutorResult, ToolExecutionContext } from '../tools/types'

/** Invocation scoped typed view: the active MCP snapshot decides existence, coordinator owns dispatch. */
export function createRegisteredMcpTool(executor: ToolExecutor) {
  return defineDirectTool<Record<string, unknown>, ToolExecutorResult>({
    name: executor.name,
    actionClass: 'outbound',
    parseInput(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MCP_TOOL_INPUT_INVALID')
      return raw as Record<string, unknown>
    },
    execute(input, execution) {
      const runtime = execution.runtimeContext
      if (!runtime) throw new Error('MCP_TOOL_RUNTIME_CONTEXT_REQUIRED')
      const dispatched: ToolExecutionContext = {
        ...runtime,
        requestId: execution.requestId,
        toolUseId: execution.toolUseId,
        signal: execution.signal
      }
      return executor.execute(input, dispatched)
    }
  })
}
