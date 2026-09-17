import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_TIMEOUT_SEC_MAX,
  MCP_TIMEOUT_SEC_MIN,
  McpServerWriteInputSchema,
  type McpServerWriteInput
} from '../../src/shared/mcpTypes'
import { validateMcpEndpoint } from './endpointPolicy'
import { listProfiles, saveProfiles } from './mcpConfigStore'
import { getSecret } from './mcpSecretStore'
import { McpConnectionManager, testConnection } from './mcpConnectionManager'
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js'
import { matchOauthClientPreset, MCP_OAUTH_CLIENT_PRESETS, type McpOAuthClientPreset } from './oauthClientPresets'
import { createMcpOAuthClientProvider, isOAuthFlowActive, startOAuthFlow } from './mcpOauthService'
import { buildMappedToolDescriptors } from './mcpToolRegistry'

/**
 * mcpService（前案 §5.2.1，toolkit Phase 2 沿用）：把 mcpIpc 内联编排逻辑抽为 service 层，
 * IPC 处理器与 Agent 能力（action.mcp.add）共用同一入口，避免双实现漂移。
 *
 * action.mcp.add 行为规范（前案 §5.2.2）：
 * 校验 endpoint 策略 → 保存 profile → 自动做一次 OAuth discovery（只读，不发起授权），
 * 返回「支持 OAuth(DCR) / 需 Client ID / 不支持 OAuth 仅 Bearer」的结构化结论。
 * 本期不含会话内 OAuth login——授权降级为引导用户在设置页点击（需求 §1.4）。
 */

export type McpAddAuthMode = 'none' | 'bearer-token' | 'custom-header' | 'oauth'

export interface McpAddServerParams {
  name: string
  transport: 'http' | 'stdio'
  /** http 必填 */
  endpoint?: string
  /** stdio 必填 */
  command?: string
  args?: string[]
  /** stdio 环境变量表（值将加密存储，结果中只出存在性旗标） */
  env?: Record<string, string>
  /** 缺省：http → oauth；stdio → none */
  authMode?: McpAddAuthMode
  accessToken?: string
  headerValue?: string
  headerName?: string
  oauthClientId?: string
  oauthScopes?: string[]
}

export type McpAddServerConclusion =
  | { kind: 'oauth-dcr'; message: string }
  | { kind: 'oauth-client-id'; message: string; presetMatched: boolean; clientIdProvided: boolean }
  | { kind: 'bearer-only'; message: string }
  | { kind: 'none'; message: string }

export type McpAddServerResult =
  | {
      ok: true
      serverId: string
      conclusion: McpAddServerConclusion
      /** 本期（Phase 2）授权入口：设置页。Phase 3 增加 action.mcp.login 后由 Agent 直接发起。 */
      guide: string
    }
  | { ok: false; code: 'endpoint-policy-blocked' | 'invalid-params' | 'save-failed'; message: string }

export interface McpAddServerOptions {
  /** 测试缝：预设目录注入（缺省 MCP_OAUTH_CLIENT_PRESETS） */
  presets?: McpOAuthClientPreset[]
}

const SETTING_PAGE_GUIDE =
    '本期不支持会话内授权：请在设置页 → MCP 服务中对该服务点击「连接/授权」完成 OAuth 登录后再使用'

function buildWriteInput(params: McpAddServerParams, endpoint: string | undefined): McpServerWriteInput {
  const authMode: McpAddAuthMode = params.authMode ?? (params.transport === 'http' ? 'oauth' : 'none')
  const input: McpServerWriteInput = {
    id: randomUUID(),
    name: params.name,
    enabled: true,
    transport: params.transport === 'http' ? 'streamable-http' : 'stdio',
    timeoutSec: Math.min(Math.max(30, MCP_TIMEOUT_SEC_MIN), MCP_TIMEOUT_SEC_MAX),
    auth: {
      mode: authMode,
      ...(params.headerName ? { headerName: params.headerName } : {}),
      ...(params.oauthClientId ? { oauthClientId: params.oauthClientId } : {}),
      ...(params.oauthScopes?.length ? { oauthScopes: params.oauthScopes } : {}),
      // Secret 只经 buildSecretChanges 加密落库，不进 Profile JSON
      ...(params.accessToken?.trim() ? { accessToken: params.accessToken.trim() } : {}),
      ...(params.headerValue?.trim() ? { headerValue: params.headerValue.trim() } : {})
    },
    ...(params.transport === 'stdio' && params.command
      ? {
          stdio: {
            command: params.command,
            args: params.args ?? [],
            env: Object.entries(params.env ?? {}).map(([key, value]) => ({
              key,
              valuePresent: value.length > 0,
              ...(value.length > 0 ? { value } : {})
            }))
          }
        }
      : {}),
    ...(endpoint ? { http: { endpoint } } : {}),
    enabledToolNames: []
  }
  return McpServerWriteInputSchema.parse(input)
}

async function discoverConclusion(
  params: McpAddServerParams,
  endpoint: string,
  options?: McpAddServerOptions
): Promise<McpAddServerConclusion> {
  if (params.transport !== 'http') {
    return { kind: 'none', message: 'stdio 传输不涉及 OAuth 发现' }
  }
  try {
    const info = await discoverOAuthServerInfo(new URL(endpoint))
    const metadata = info.authorizationServerMetadata
    if (!metadata) {
      return {
        kind: 'bearer-only',
        message: '未发现 OAuth 授权服务器元数据：该服务可能不支持 OAuth，请使用 Bearer token 认证'
      }
    }
    if (metadata.registration_endpoint) {
      return { kind: 'oauth-dcr', message: '该服务支持 OAuth 动态客户端注册（DCR），可直接在设置页发起授权' }
    }
    const preset = matchOauthClientPreset(
      new URL(endpoint).origin,
      metadata.issuer ?? '',
      options?.presets ?? MCP_OAUTH_CLIENT_PRESETS
    )
    return {
      kind: 'oauth-client-id',
      presetMatched: Boolean(preset),
      clientIdProvided: Boolean(params.oauthClientId?.trim()),
      message: preset
        ? `该服务不支持 DCR，但已匹配内置预设「${preset.displayName}」，可直接在设置页发起授权`
        : '该服务不支持 DCR：需要提供 OAuth Client ID（在设置页该服务的认证方式中填写）后授权，或改用 Bearer token'
    }
  } catch {
    return {
      kind: 'bearer-only',
      message: 'OAuth 发现不可达：该服务可能不支持 OAuth（或发现端点暂不可用），请改用 Bearer token 或稍后重试'
    }
  }
}

/**
 * 添加 MCP 连接（action.mcp.add 的执行入口）。
 * endpoint 校验走 endpointPolicy（私网/保留地址拒绝）；重定向拒绝在传输/连接层独立兜底。
 */
export async function addMcpServer(
  db: AppDatabase,
  params: McpAddServerParams,
  options?: McpAddServerOptions
): Promise<McpAddServerResult> {
  let endpoint: string | undefined
  if (params.transport === 'http') {
    if (!params.endpoint?.trim()) {
      return { ok: false, code: 'invalid-params', message: 'http 传输必须提供 endpoint' }
    }
    const validation = validateMcpEndpoint(params.endpoint.trim())
    if (!validation.ok) {
      return { ok: false, code: 'endpoint-policy-blocked', message: `endpoint 被安全策略拒绝：${validation.message}` }
    }
    endpoint = validation.normalized
  } else if (!params.command?.trim()) {
    return { ok: false, code: 'invalid-params', message: 'stdio 传输必须提供 command' }
  }

  let input: McpServerWriteInput
  try {
    input = buildWriteInput(params, endpoint)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'invalid-params', message: `参数校验失败：${message}` }
  }

  try {
    await saveProfiles(db, [input])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'save-failed', message }
  }

  const conclusion = endpoint
    ? await discoverConclusion(params, endpoint, options)
    : { kind: 'none' as const, message: '该认证模式不涉及 OAuth 发现' }

  return {
    ok: true,
    serverId: input.id,
    conclusion,
    guide: SETTING_PAGE_GUIDE
  }
}

/** 已保存 profile 的紧凑摘要（不含任何 secret；供 find/审计与结果展示）。 */
export function describeSavedServer(db: AppDatabase, serverId: string): { id: string; name: string; transport: string; authMode: string } | undefined {
  const profile = listProfiles(db).find((p) => p.id === serverId)
  if (!profile) return undefined
  return { id: profile.id, name: profile.name, transport: profile.transport, authMode: profile.auth.mode }
}

export type McpTestConnectionResult = Record<string, unknown>

/**
 * 连接测试编排（自 mcpIpc 抽取，前案 §5.2.1）：草稿 secret 合并、OAuth 授权触发、
 * 连接与工具发现。IPC 处理器与 Agent 能力共用同一入口。
 */
export async function testMcpConnection(db: AppDatabase, input: McpServerWriteInput): Promise<McpTestConnectionResult> {
  const profile: ReturnType<typeof writeProfileFromInput> = writeProfileFromInput(input)

  const draftSecrets: Record<string, string> = {}
  if (input.auth.accessToken?.trim()) draftSecrets['access-token'] = input.auth.accessToken.trim()
  if (input.auth.headerValue?.trim()) draftSecrets['auth-header'] = input.auth.headerValue.trim()
  for (const env of input.stdio?.env ?? []) {
    if (env.value !== undefined && env.value !== '') draftSecrets[`env:${env.key}`] = env.value
  }
  // 草稿未填写的新值优先；已保存服务编辑草稿留空时回退到已保存 Secret，
  // 避免「已配好 token 只是没重填」被误判为未认证。
  const secretProvider = async (kind: string): Promise<string | null> =>
    draftSecrets[kind] ?? (await getSecret(db, profile.id, kind))

  // OAuth 服务：已保存 token 直接携带；未授权则先跑一次授权流程（草稿 profile），
  // 授权成功后 token 落在草稿 id 下，再按已授权状态连接。
  let oauthProvider: ReturnType<typeof createMcpOAuthClientProvider> | undefined
  if (profile.auth.mode === 'oauth') {
    oauthProvider = createMcpOAuthClientProvider(db, profile)
    const hasToken = await getSecret(db, profile.id, 'access-token')
    if (!hasToken) {
      const oauthResult = await startOAuthFlow(db, profile.id, { profile })
      if (!oauthResult.ok) return oauthResult
    }
  }

  const result = await testConnection(profile, {
    connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
    secretProvider,
    oauthProvider
  })
  if (!result.ok) return result as McpTestConnectionResult
  const { descriptors, skipped } = buildMappedToolDescriptors(input.id, input.name, result.tools)
  return {
    ok: true,
    serverName: result.serverInfo.name,
    protocolVersion: result.protocolVersion,
    capabilities: result.capabilities,
    tools: descriptors,
    skipped
  } as McpTestConnectionResult
}

function writeProfileFromInput(input: McpServerWriteInput) {
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
    status: 'untested' as const,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  }
}

export { isOAuthFlowActive }
