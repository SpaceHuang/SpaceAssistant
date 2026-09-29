import { TypedToolRegistry } from '../tools/plannedToolRegistry'
import type { ToolExecutor } from '../tools/types'
import { createRegisteredMcpTool } from './registeredMcpTool'
import type { McpToolSnapshot } from './mcpToolRegistry'
import type { McpConnectionManager } from './mcpConnectionManager'

/** Build a per-turn typed registry from the exact MCP snapshot exposed to the model. */
export function createHostedMcpToolRegistry(input: {
  base: TypedToolRegistry
  snapshot: McpToolSnapshot
  manager: McpConnectionManager
  resolveExecutor(toolName: string, manager: McpConnectionManager): ToolExecutor | undefined
}): TypedToolRegistry {
  const registry = new TypedToolRegistry()
  for (const tool of input.base.entries()) registry.register(tool)
  for (const [name, entry] of input.snapshot.entries) {
    if (entry.mappedName !== name) throw new Error(`MCP_SNAPSHOT_NAME_MISMATCH:${name}`)
    const executor = input.resolveExecutor(name, input.manager)
    if (!executor || executor.name !== name) throw new Error(`MCP_REGISTERED_EXECUTOR_UNAVAILABLE:${name}`)
    registry.register(createRegisteredMcpTool(executor))
  }
  return registry
}
