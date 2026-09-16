import type { McpConfig } from '../../shared/mcpTypes'

export type McpToolCatalogEntry = {
  serverId: string
  serverName: string
  originalToolName: string
  description?: string
}

let catalog = new Map<string, McpToolCatalogEntry>()

export function buildMcpToolCatalog(config: McpConfig): void {
  const next = new Map<string, McpToolCatalogEntry>()
  for (const server of config.servers) {
    for (const tool of config.toolCaches?.[server.id]?.tools ?? []) {
      next.set(tool.mappedName, {
        serverId: server.id,
        serverName: server.name,
        originalToolName: tool.originalName,
        description: tool.description || undefined
      })
    }
  }
  catalog = next
}

export function resolveMcpToolFromCatalog(toolName: string): McpToolCatalogEntry | undefined {
  return catalog.get(toolName)
}

export async function refreshMcpToolCatalog(): Promise<void> {
  try {
    const config = await window.api.mcpList()
    buildMcpToolCatalog(config)
  } catch (error) {
    console.warn('[mcp] failed to refresh tool catalog; keeping previous snapshot', error instanceof Error ? error.message : String(error))
  }
}
