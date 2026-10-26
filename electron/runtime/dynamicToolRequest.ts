import type { AgentTurnObserver } from '../../packages/agent-sdk/src/turn'

export interface DynamicModelTool {
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
}

export function withDynamicToolsObserver(
  observer: AgentTurnObserver,
  getDynamicTools: () => readonly DynamicModelTool[]
): AgentTurnObserver {
  return {
    ...observer,
    prepareModelRequest: async (request) => {
      const base = await observer.prepareModelRequest?.(request)
      const dynamicTools = getDynamicTools()
      if (dynamicTools.length === 0) return base
      const existing = request.request.tools?.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      const tools = mergeDynamicTools(existing, dynamicTools)
      return {
        ...base,
        requestPatch: {
          ...base?.requestPatch,
          tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
        }
      }
    }
  }
}

/** Merge request-local discovered schemas without mutating the base request or any auth set. */
export function mergeDynamicTools(
  base: readonly DynamicModelTool[] | undefined,
  discovered: readonly DynamicModelTool[]
): DynamicModelTool[] {
  const merged = new Map<string, DynamicModelTool>()
  for (const tool of base ?? []) merged.set(tool.name, tool)
  for (const tool of discovered) {
    if (!tool.name.trim() || !tool.description.trim() || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) continue
    merged.set(tool.name, tool)
  }
  return [...merged.values()]
}
