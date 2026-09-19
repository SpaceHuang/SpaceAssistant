import type { IpcMain } from 'electron'
import type { AppIpcContext } from '../appIpc'
import {
  McpSaveProfilesPayloadSchema,
  McpTestConnectionPayloadSchema,
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
import { rejectPendingConfirmsForToolAcrossLanes } from '../toolConfirmRegistry'
import { revokeToolForAllLanes } from '../toolRevocationRegistry'
import { clearSecret, getSecret } from './mcpSecretStore'
import { clearDiagnostics, getDiagnostics, safeAppendDiagnostic } from './mcpDiagnostics'
import { McpConnectionManager } from './mcpConnectionManager'
import { discoverToolsFromSession, getCachedTools } from './mcpToolRegistry'
import {
  createMcpOAuthClientProvider,
  isOAuthFlowActive,
  MCP_AUTH_REQUIRED_MESSAGE,
  startOAuthFlow
} from './mcpOauthService'
import { testMcpConnection } from './mcpService'

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
    status: 'untested',
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  }
}

function revokeMcpToolsThatBecameUnavailable(
  previous: McpServerProfile[],
  next: McpServerProfile[]
): void {
  const nextById = new Map(next.map((profile) => [profile.id, profile]))
  for (const oldProfile of previous) {
    const nextProfile = nextById.get(oldProfile.id)
    const nextNames = nextProfile?.enabled ? new Set(nextProfile.enabledToolNames) : new Set<string>()
    for (const toolName of oldProfile.enabledToolNames) {
      if (nextNames.has(toolName)) continue
      revokeToolForAllLanes(toolName)
      rejectPendingConfirmsForToolAcrossLanes(toolName)
    }
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
    const previous = listProfiles(ctx.db)
    const next = parsed.servers.map(writeInputToProfile)
    revokeMcpToolsThatBecameUnavailable(previous, next)
    const servers = await saveProfiles(ctx.db, parsed.servers)
    return { servers }
  })

  ipcMain.handle('mcp:test-connection', async (_e, payload: unknown) => {
    const parsed = McpTestConnectionPayloadSchema.parse(payload)
    // 编排逻辑已抽取到 mcpService（前案 §5.2.1）；IPC 仅做载荷解析与委托
    return testMcpConnection(ctx.db, parsed.server)
  })

  ipcMain.handle('mcp:delete-server', async (_e, payload: { serverId?: unknown }) => {
    const serverId = typeof payload?.serverId === 'string' ? payload.serverId : ''
    if (!serverId) throw new Error('serverId 不能为空')
    if (isOAuthFlowActive(serverId)) {
      throw new Error('该服务正在授权中，暂不能删除')
    }
    const previous = listProfiles(ctx.db)
    const deleted = previous.find((profile) => profile.id === serverId)
    for (const toolName of deleted?.enabledToolNames ?? []) {
      revokeToolForAllLanes(toolName)
      rejectPendingConfirmsForToolAcrossLanes(toolName)
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
      appendDiagnostic: (id, entry) => safeAppendDiagnostic(ctx.db, id, entry)
    })
    // 后台刷新禁止静默发起交互式授权：token 失效时返回 auth-required，引导用户点「连接账户」。
    let interactiveAuthRequired = false
    try {
      const secretProvider = async (kind: string): Promise<string | null> => getSecret(ctx.db, serverId, kind)
      const oauthProvider =
        profile.auth.mode === 'oauth'
          ? createMcpOAuthClientProvider(ctx.db, profile, {
              interactive: false,
              onInteractiveAuthRequired: () => {
                interactiveAuthRequired = true
              }
            })
          : undefined
      const session = await manager.connect(profile, secretProvider, { oauthProvider })
      const discovery = await discoverToolsFromSession(ctx.db, profile, session)
      if (!discovery.ok) {
        if (interactiveAuthRequired) {
          await updateServerStatus(ctx.db, serverId, {
            status: 'auth-required',
            lastError: { code: 'auth-required', message: MCP_AUTH_REQUIRED_MESSAGE, occurredAt: new Date().toISOString() }
          })
          return { ok: false, code: 'auth-required', message: MCP_AUTH_REQUIRED_MESSAGE }
        }
        await updateServerStatus(ctx.db, serverId, {
          status: 'failed',
          lastError: { code: discovery.code, message: discovery.message, occurredAt: new Date().toISOString() }
        })
        return discovery
      }
      // 白名单自动回填：服务启用且从未勾选过工具（如会话内 action.mcp.add 创建后仅在设置页完成授权）
      // 时，刷新发现成功即全选本次工具，消除「已连接但 0 工具注入」的静默不可用态；已有选择不覆盖。
      const current = listProfiles(ctx.db).find((p) => p.id === serverId)
      const shouldAutoFillEnabledTools =
        current?.enabled === true && current.enabledToolNames.length === 0 && discovery.tools.length > 0
      await updateServerStatus(ctx.db, serverId, {
        status: discovery.tools.length > 0 ? 'connected' : 'no-tools',
        discoveredAt: new Date().toISOString(),
        discoveredProtocolVersion: discovery.protocolVersion,
        clearLastError: true,
        ...(shouldAutoFillEnabledTools
          ? { enabledToolNames: discovery.tools.map((tool) => tool.originalName) }
          : {})
      })
      return {
        ok: true,
        serverName: discovery.serverName,
        tools: discovery.tools,
        // 回填告知标记：UI 据此提示「已自动启用 N 个工具」，避免静默改库
        ...(shouldAutoFillEnabledTools ? { autoEnabledToolCount: discovery.tools.length } : {})
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      safeAppendDiagnostic(ctx.db, serverId, { code: 'refresh-failed', message })
      if (interactiveAuthRequired) {
        await updateServerStatus(ctx.db, serverId, {
          status: 'auth-required',
          lastError: { code: 'auth-required', message: MCP_AUTH_REQUIRED_MESSAGE, occurredAt: new Date().toISOString() }
        })
        return { ok: false, code: 'auth-required', message: MCP_AUTH_REQUIRED_MESSAGE }
      }
      await updateServerStatus(ctx.db, serverId, {
        status: 'failed',
        lastError: { code: 'refresh-failed', message, occurredAt: new Date().toISOString() }
      })
      return { ok: false, code: 'refresh-failed', message }
    } finally {
      await manager.shutdown().catch(() => undefined)
    }
  })
}
