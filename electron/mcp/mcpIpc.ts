import type { IpcMain } from 'electron'
import type { AppIpcContext } from '../appIpc'
import {
  McpSaveProfilesPayloadSchema,
  McpTestConnectionPayloadSchema,
  MCP_CONNECT_TIMEOUT_MS,
  type McpServerProfile,
  type McpServerWriteInput
} from '../../src/shared/mcpTypes'
import {
  deleteServer,
  listProfiles,
  refreshProfilesSecretFlags,
  saveProfiles,
  updateServerStatus
} from './mcpConfigStore'
import { clearSecret, getSecret } from './mcpSecretStore'
import { appendDiagnostic, clearDiagnostics, getDiagnostics } from './mcpDiagnostics'
import { McpConnectionManager, testConnection } from './mcpConnectionManager'
import { buildMappedToolDescriptors, discoverToolsFromSession, getCachedTools } from './mcpToolRegistry'
import { isOAuthFlowActive, startOAuthFlow } from './mcpOauthService'

/**
 * mcp:* IPC 处理器注册（被 appIpc.ts 调用）。
 * 所有来自渲染进程的 serverId、工具名、endpoint、命令、header 和 Secret 都在主进程再次校验。
 */

function writeInputToProfile(input: McpServerWriteInput): McpServerProfile {
  const now = new Date().toISOString()
  return {
    id: input.id,
    name: input.name.trim(),
    enabled: input.enabled,
    transport: input.transport,
    timeoutSec: input.timeoutSec,
    auth: {
      mode: input.auth.mode,
      secretPresent: false,
      headerName: input.auth.headerName,
      valuePrefix: input.auth.valuePrefix,
      oauthClientId: input.auth.oauthClientId,
      oauthScopes: input.auth.oauthScopes,
      accessTokenExpiresAt: input.auth.accessTokenExpiresAt
    },
    ...(input.stdio
      ? {
          stdio: {
            command: input.stdio.command,
            args: input.stdio.args,
            ...(input.stdio.cwd ? { cwd: input.stdio.cwd } : {}),
            env: input.stdio.env.map((e) => ({ key: e.key, valuePresent: e.valuePresent })),
            ...(input.stdio.commandTrustedAt ? { commandTrustedAt: input.stdio.commandTrustedAt } : {})
          }
        }
      : {}),
    ...(input.http ? { http: { endpoint: input.http.endpoint } } : {}),
    enabledToolNames: input.enabledToolNames,
    toolConfirmPolicy: input.toolConfirmPolicy,
    status: 'untested',
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  }
}

export function registerMcpIpcHandlers(ipcMain: IpcMain, ctx: AppIpcContext): void {
  ipcMain.handle('mcp:list', () => {
    const servers = refreshProfilesSecretFlags(ctx.db)
    const toolCaches: Record<string, unknown> = {}
    for (const server of servers) {
      const cache = getCachedTools(ctx.db, server.id)
      if (cache) toolCaches[server.id] = cache
    }
    return { servers, toolCaches }
  })

  ipcMain.handle('mcp:save-profiles', async (_e, payload: unknown) => {
    const parsed = McpSaveProfilesPayloadSchema.parse(payload)
    for (const server of parsed.servers) {
      if (isOAuthFlowActive(server.id)) {
        throw new Error('该服务正在授权中，暂不能编辑')
      }
    }
    const servers = await saveProfiles(ctx.db, parsed.servers)
    return { servers }
  })

  ipcMain.handle('mcp:test-connection', async (_e, payload: unknown) => {
    const parsed = McpTestConnectionPayloadSchema.parse(payload)
    const input = parsed.server
    const profile = writeInputToProfile(input)

    const draftSecrets: Record<string, string> = {}
    if (input.auth.accessToken?.trim()) draftSecrets['access-token'] = input.auth.accessToken.trim()
    if (input.auth.headerValue?.trim()) draftSecrets['auth-header'] = input.auth.headerValue.trim()
    for (const env of input.stdio?.env ?? []) {
      if (env.value !== undefined && env.value !== '') draftSecrets[`env:${env.key}`] = env.value
    }
    const secretProvider = async (kind: string): Promise<string | null> => draftSecrets[kind] ?? null

    const result = await testConnection(profile, {
      connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
      secretProvider
    })
    if (!result.ok) return result
    const { descriptors, skipped } = buildMappedToolDescriptors(input.id, input.name, result.tools)
    return {
      ok: true,
      serverName: result.serverInfo.name,
      protocolVersion: result.protocolVersion,
      capabilities: result.capabilities,
      tools: descriptors,
      skipped
    }
  })

  ipcMain.handle('mcp:delete-server', async (_e, payload: { serverId?: unknown }) => {
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : ''
    if (!serverId) throw new Error('serverId 不能为空')
    if (isOAuthFlowActive(serverId)) {
      throw new Error('该服务正在授权中，暂不能删除')
    }
    await deleteServer(ctx.db, serverId)
    return { ok: true }
  })

  ipcMain.handle('mcp:clear-secret', async (_e, payload: { serverId?: unknown; kind?: unknown }) => {
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : ''
    const kind = typeof payload?.kind === 'string' ? payload.kind : ''
    if (!serverId || !kind) throw new Error('参数无效')
    if (isOAuthFlowActive(serverId)) {
      throw new Error('该服务正在授权中，暂不能清除凭据')
    }
    await clearSecret(ctx.db, serverId, kind)
    return { servers: refreshProfilesSecretFlags(ctx.db) }
  })

  ipcMain.handle('mcp:get-diagnostics', (_e, payload: { serverId?: unknown }) => {
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : ''
    if (!serverId) return { diagnostics: [] }
    return { diagnostics: getDiagnostics(ctx.db, serverId) }
  })

  ipcMain.handle('mcp:clear-diagnostics', (_e, payload: { serverId?: unknown }) => {
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : ''
    if (!serverId) throw new Error('serverId 不能为空')
    clearDiagnostics(ctx.db, serverId)
    return { ok: true }
  })

  ipcMain.handle('mcp:oauth-start', async (_e, payload: { serverId?: unknown }) => {
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : ''
    if (!serverId) throw new Error('serverId 不能为空')
    return startOAuthFlow(ctx.db, serverId)
  })

  ipcMain.handle('mcp:refresh-tools', async (_e, payload: { serverId?: unknown }) => {
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : ''
    if (!serverId) throw new Error('serverId 不能为空')
    const profile = listProfiles(ctx.db).find((p) => p.id === serverId)
    if (!profile) return { ok: false, code: 'not-found', message: '服务不存在' }

    const manager = new McpConnectionManager({
      appendDiagnostic: (id, entry) => appendDiagnostic(ctx.db, id, entry)
    })
    try {
      const secretProvider = async (kind: string): Promise<string | null> => getSecret(ctx.db, serverId, kind)
      const session = await manager.connect(profile, secretProvider)
      const discovery = await discoverToolsFromSession(ctx.db, profile, session)
      if (!discovery.ok) {
        updateServerStatus(ctx.db, serverId, {
          status: 'failed',
          lastError: { code: discovery.code, message: discovery.message, occurredAt: new Date().toISOString() }
        })
        return discovery
      }
      updateServerStatus(ctx.db, serverId, {
        status: discovery.tools.length > 0 ? 'connected' : 'no-tools',
        discoveredAt: new Date().toISOString(),
        discoveredProtocolVersion: discovery.protocolVersion,
        clearLastError: true
      })
      return { ok: true, serverName: discovery.serverName, tools: discovery.tools }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void appendDiagnostic(ctx.db, serverId, { code: 'refresh-failed', message })
      updateServerStatus(ctx.db, serverId, {
        status: 'failed',
        lastError: { code: 'refresh-failed', message, occurredAt: new Date().toISOString() }
      })
      return { ok: false, code: 'refresh-failed', message }
    } finally {
      await manager.shutdown().catch(() => undefined)
    }
  })
}
