import type { AppDatabase } from '../database'
import { addMcpServer, type McpAddServerParams } from './mcpService'
import { listProfiles } from './mcpConfigStore'
import { getCachedTools } from './mcpToolRegistry'

export type McpCapabilityServerSummary = Readonly<{
  id: string
  name: string
  enabled: boolean
  transport: string
  status: string
  authMode: string
  secretPresent: boolean
  discoveredToolCount: number
  enabledToolCount: number
  enabledToolNames: readonly string[]
  lastError?: { code: string }
  hint?: string
}>

/** Capability-facing MCP config port; database assembly and secret-safe summary projection stay in the MCP adapter. */
export function createMcpCapabilityConfigPort(db: AppDatabase) {
  return Object.freeze({
    addServer: (params: unknown) => addMcpServer(db, params as McpAddServerParams),
    listServers: (): McpCapabilityServerSummary[] => listProfiles(db).map((profile) => {
      const discoveredToolCount = getCachedTools(db, profile.id)?.tools.length ?? 0
      const enabledToolCount = profile.enabledToolNames.length
      const base = {
        id: profile.id,
        name: profile.name,
        enabled: profile.enabled,
        transport: profile.transport,
        status: profile.status,
        authMode: profile.auth.mode,
        secretPresent: profile.auth.secretPresent,
        discoveredToolCount,
        enabledToolCount,
        enabledToolNames: [...profile.enabledToolNames],
        ...(profile.lastError ? { lastError: { code: profile.lastError.code } } : {})
      }
      return profile.enabled && discoveredToolCount > 0 && enabledToolCount === 0
        ? { ...base, hint: `该服务已连接并发现 ${discoveredToolCount} 个工具，但尚未启用任何一个——会话中不可用；请引导用户到设置页 → MCP 服务中勾选工具` }
        : base
    })
  })
}
