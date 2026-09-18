import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_TIMEOUT_SEC_MAX,
  MCP_TIMEOUT_SEC_MIN,
  McpServerWriteInputSchema,
  type McpServerProfile,
  type McpServerWriteInput,
  type McpTestConnectionResult
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

/** discovery 每跳超时与重定向跟随上限（评审 S4/S5） */
const DISCOVERY_TIMEOUT_MS = 5_000
const DISCOVERY_MAX_REDIRECTS = 3

/**
 * discovery 专用 fetch（评审 S5）：SDK 默认 fetch 自动跟随重定向，会绕过 endpoint
 * 安全策略（公网 302 → 内网探测）。这里手动跟随每一跳并对目标重新过 endpointPolicy；
 * 被拦截的跳转返回合成 403（SDK 会吞掉 fetchFn 抛错，用状态码表达失败）并记录拦截态，
 * 供结论文案区分「不支持 OAuth」与「发现被安全策略拦截」。超时经 AbortSignal 强制收敛（评审 S4）。
 */
function createSafeDiscoveryFetch(
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  onBlocked?: (target: URL) => void
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const assertTargetAllowed = (target: URL): boolean => {
    const validation = validateMcpEndpoint(target.toString())
    if (!validation.ok) {
      onBlocked?.(target)
      return false
    }
    return true
  }
  return async (url, init) => {
    let current = new URL(url.toString())
    if (!assertTargetAllowed(current)) {
      return new Response(null, { status: 403, statusText: 'endpoint policy blocked' })
    }
    for (let hop = 0; ; hop++) {
      const response = await fetch(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      if (response.status < 300 || response.status >= 400) return response
      const location = response.headers.get('location')
      if (!location) return response
      if (hop >= DISCOVERY_MAX_REDIRECTS) {
        onBlocked?.(current)
        return new Response(null, { status: 508, statusText: 'redirect loop limit' })
      }
      current = new URL(location, current)
      if (!assertTargetAllowed(current)) {
        return new Response(null, { status: 403, statusText: 'endpoint policy blocked' })
      }
    }
  }
}

async function discoverConclusion(
  params: McpAddServerParams,
  endpoint: string,
  options?: McpAddServerOptions
): Promise<McpAddServerConclusion> {
  if (params.transport !== 'http') {
    return { kind: 'none', message: 'stdio 传输不涉及 OAuth 发现' }
  }
  let blocked = false
  let timedOut = false
  const blockedConclusion: McpAddServerConclusion = {
    kind: 'bearer-only',
    message: 'OAuth 发现被安全策略拦截（存在指向私网/保留地址的重定向）：该端点暂按不支持 OAuth 处理'
  }
  try {
    const info = await discoverOAuthServerInfo(new URL(endpoint), {
      fetchFn: createSafeDiscoveryFetch(DISCOVERY_TIMEOUT_MS, () => {
        blocked = true
      })
    })
    if (blocked) return blockedConclusion
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
  } catch (error) {
    if (blocked) return blockedConclusion
    timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return {
      kind: 'bearer-only',
      message: timedOut
        ? 'OAuth 发现超时：无法确认该服务是否支持 OAuth，请稍后在设置页重试，或改用 Bearer token 认证'
        : 'OAuth 发现不可达：该服务可能不支持 OAuth（或发现端点暂不可用），请改用 Bearer token 或稍后重试'
    }
  }
}

/**
 * 既有 profile → write input（评审 B2）：saveProfiles 是全量保存语义，
 * addMcpServer 必须把既有服务合并进列表再保存，否则既有服务及其加密凭据会被清空。
 * secret 不回填（保留在 secret map 中，saveProfiles 对未出现的 kind 不做 clear）。
 */
function existingProfilesAsWriteInputs(profiles: McpServerProfile[]): McpServerWriteInput[] {
  return profiles.map((p) => ({
    id: p.id,
    name: p.name,
    enabled: p.enabled,
    transport: p.transport,
    timeoutSec: p.timeoutSec,
    auth: {
      mode: p.auth.mode,
      ...(p.auth.headerName ? { headerName: p.auth.headerName } : {}),
      ...(p.auth.valuePrefix ? { valuePrefix: p.auth.valuePrefix } : {}),
      ...(p.auth.oauthClientId ? { oauthClientId: p.auth.oauthClientId } : {}),
      ...(p.auth.oauthScopes?.length ? { oauthScopes: p.auth.oauthScopes } : {}),
      ...(p.auth.accessTokenExpiresAt ? { accessTokenExpiresAt: p.auth.accessTokenExpiresAt } : {})
    },
    ...(p.stdio
      ? {
          stdio: {
            command: p.stdio.command,
            args: p.stdio.args,
            ...(p.stdio.cwd ? { cwd: p.stdio.cwd } : {}),
            env: p.stdio.env.map((e) => ({ key: e.key, valuePresent: e.valuePresent }))
          }
        }
      : {}),
    ...(p.http ? { http: { endpoint: p.http.endpoint } } : {}),
    enabledToolNames: p.enabledToolNames,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }))
}

/**
 * 添加 MCP 连接（action.mcp.add 的执行入口）。
 * - endpoint 校验走 endpointPolicy（私网/保留地址拒绝）；
 * - OAuth discovery 在保存前执行且带超时（评审 S4），重定向经安全策略拦截（评审 S5）；
 * - 保存为追加语义：既有服务与凭据保留（评审 B2），与既有服务重名会因查重失败而保存失败。
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

  // discovery 先于落库（评审 S4）：发现超时/被拦截不影响已保存状态与返回语义的一致性
  const conclusion = endpoint
    ? await discoverConclusion(params, endpoint, options)
    : { kind: 'none' as const, message: '该认证模式不涉及 OAuth 发现' }

  try {
    const existing = existingProfilesAsWriteInputs(listProfiles(db))
    await saveProfiles(db, [...existing, input])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'save-failed', message }
  }

  return {
    ok: true,
    serverId: input.id,
    conclusion,
    guide: SETTING_PAGE_GUIDE
  }
}



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

