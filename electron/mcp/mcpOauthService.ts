import { randomBytes } from 'crypto'
import http from 'http'
import { shell } from 'electron'
import {
  auth,
  discoverOAuthServerInfo,
  UnauthorizedError,
  type OAuthClientProvider
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AppDatabase } from '../database'
import { deleteConfigValue, getConfigValue, setConfigValue } from '../database'
import type { McpServerProfile } from '../../src/shared/mcpTypes'
import {
  getSecret,
  setSecret
} from './mcpSecretStore'
import { listProfiles, updateServerStatus } from './mcpConfigStore'
import { matchOauthClientPreset, type McpOAuthClientPreset } from './oauthClientPresets'
import { createStreamableHttpTransport } from './streamableHttpTransport'
import { resolveOauthAuthorizationServerOrigin } from './mcpConnectionManager'

/**
 * MCP OAuth 2.1 服务：metadata 发现、PKCE（SDK）、state、固定 loopback 回调、
 * DCR → 内置预设 → 手工 clientId 解析、token 生命周期（保存/刷新/失效）。
 * 授权中锁定该服务编辑（mcpIpc 校验 isOAuthFlowActive）。
 */

export const MCP_OAUTH_LOOPBACK_PORT = 42188
export const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000

export class OAuthCallbackTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthCallbackTimeoutError'
  }
}

function oauthClientInfoKey(serverId: string): string {
  return `config.mcpOauthClientInfo.${serverId}`
}

const activeFlows = new Set<string>()

export function isOAuthFlowActive(serverId: string): boolean {
  return activeFlows.has(serverId)
}

export function hasActiveOAuthFlows(): boolean {
  return activeFlows.size > 0
}

function waitForLoopbackCode(
  port: number,
  expectedState: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname === '/callback' && url.searchParams.get('state') === expectedState) {
        const code = url.searchParams.get('code') ?? ''
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><meta charset="utf-8"><p>授权完成，可关闭此窗口。</p>')
        clearTimeout(timer)
        settled = true
        resolve(code)
        server.close()
      } else {
        res.writeHead(400)
        res.end('state mismatch')
      }
    })
    server.on('error', (error) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    server.listen(port, '127.0.0.1')
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      server.close()
      reject(new OAuthCallbackTimeoutError('授权等待超时，请重新发起连接'))
    }, timeoutMs)
  })
}

export type McpOAuthProviderOptions = {
  loopbackPort?: number
  /** 浏览器授权回调等待上限（默认 5 分钟）。 */
  callbackTimeoutMs?: number
  /** 测试缝：代替浏览器，直接返回授权码。 */
  authorize?: (authorizationUrl: URL) => Promise<string>
  openBrowser?: (url: string) => Promise<void>
  onCode?: (code: string) => void
  preset?: McpOAuthClientPreset
}

export function createMcpOAuthClientProvider(
  db: AppDatabase,
  profile: McpServerProfile,
  options?: McpOAuthProviderOptions
): OAuthClientProvider {
  const port = options?.loopbackPort ?? MCP_OAUTH_LOOPBACK_PORT
  const redirectUrl = `http://127.0.0.1:${port}/callback`
  let expectedState = ''
  let codeVerifierValue = ''

  return {
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata() {
      return {
        client_name: 'SpaceAssistant',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }
    },
    state: () => {
      expectedState = randomBytes(16).toString('hex')
      return expectedState
    },
    clientInformation: async (): Promise<OAuthClientInformationMixed | undefined> => {
      const storedRaw = getConfigValue(db, oauthClientInfoKey(profile.id))
      if (storedRaw) {
        try {
          return JSON.parse(storedRaw) as OAuthClientInformationMixed
        } catch {
          /* 损坏则回退 */
        }
      }
      if (options?.preset) {
        return { client_id: options.preset.clientId }
      }
      if (profile.auth.oauthClientId?.trim()) {
        return { client_id: profile.auth.oauthClientId.trim() }
      }
      return undefined
    },
    saveClientInformation: (clientInformation) => {
      setConfigValue(db, oauthClientInfoKey(profile.id), JSON.stringify(clientInformation))
    },
    tokens: async (): Promise<OAuthTokens | undefined> => {
      const accessToken = await getSecret(db, profile.id, 'access-token')
      if (!accessToken) return undefined
      const refreshToken = await getSecret(db, profile.id, 'refresh-token')
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        ...(profile.auth.accessTokenExpiresAt
          ? { expires_at: new Date(profile.auth.accessTokenExpiresAt).getTime() }
          : {})
      }
    },
    saveTokens: async (tokens) => {
      if (tokens.access_token) {
        await setSecret(db, profile.id, 'access-token', tokens.access_token)
      }
      if (tokens.refresh_token) {
        await setSecret(db, profile.id, 'refresh-token', tokens.refresh_token)
      }
      updateServerStatus(db, profile.id, {
        ...(tokens.expires_in
          ? {
              auth: {
                accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 0) * 1000).toISOString()
              }
            }
          : {})
      })
    },
    invalidateCredentials: async (kind) => {
      if (kind === 'all' || kind === 'tokens') {
        const { clearSecret } = await import('./mcpSecretStore')
        await clearSecret(db, profile.id, 'access-token')
        await clearSecret(db, profile.id, 'refresh-token')
      }
      if (kind === 'all') {
        deleteConfigValue(db, oauthClientInfoKey(profile.id))
      }
      updateServerStatus(db, profile.id, {
        status: 'auth-expired',
        auth: { accessTokenExpiresAt: undefined }
      })
    },
    redirectToAuthorization: async (authorizationUrl: URL) => {
      if (options?.authorize) {
        const code = await options.authorize(authorizationUrl)
        options.onCode?.(code)
        return
      }
      const open = options?.openBrowser ?? (async (url: string) => {
        await shell.openExternal(url)
      })
      await open(authorizationUrl.toString())
      const code = await waitForLoopbackCode(
        port,
        expectedState,
        options?.callbackTimeoutMs ?? MCP_OAUTH_CALLBACK_TIMEOUT_MS
      )
      options?.onCode?.(code)
    },
    saveCodeVerifier: (codeVerifier) => {
      // PKCE verifier 仅存于本次授权流程内存（不落库）
      codeVerifierValue = codeVerifier
    },
    codeVerifier: async () => codeVerifierValue
  }
}

export type McpOAuthStartResult =
  | { ok: true }
  | { ok: false; code: string; message: string }

export async function startOAuthFlow(
  db: AppDatabase,
  serverId: string,
  options?: McpOAuthProviderOptions & { fetchFn?: typeof fetch; profile?: McpServerProfile }
): Promise<McpOAuthStartResult> {
  const profile = options?.profile ?? listProfiles(db).find((p) => p.id === serverId)
  if (!profile) return { ok: false, code: 'not-found', message: '服务不存在' }
  if (!profile.http) return { ok: false, code: 'no-endpoint', message: '服务缺少 endpoint' }
  const endpoint = profile.http.endpoint
  if (activeFlows.has(serverId)) {
    return { ok: false, code: 'flow-active', message: '该服务正在授权中，请等待完成' }
  }
  activeFlows.add(serverId)

  let preset: McpOAuthClientPreset | undefined
  try {
    const serverUrl = new URL(endpoint)
    let serverInfo: Awaited<ReturnType<typeof discoverOAuthServerInfo>> | undefined
    try {
      serverInfo = await discoverOAuthServerInfo(serverUrl, { fetchFn: options?.fetchFn })
      const issuer = serverInfo.authorizationServerMetadata?.issuer
      if (issuer) {
        preset = matchOauthClientPreset(serverUrl.origin, issuer)
      }
    } catch {
      // 发现失败时由 SDK 的 401 流程自行发现；预设匹配仅在可发现 issuer 时生效
    }

    // GitHub 等不支持 DCR 的服务必须提供手工 OAuth Client ID，否则会得到
    // 404/401 之类的晦涩错误；支持 DCR（registration_endpoint）的服务无需预填。
    const authServerMetadata = serverInfo?.authorizationServerMetadata
    const canRegisterDynamically = Boolean(authServerMetadata?.registration_endpoint)
    const hasClientIdentity = Boolean(
      getConfigValue(db, oauthClientInfoKey(profile.id)) ||
        preset ||
        profile.auth.oauthClientId?.trim()
    )
    if (!canRegisterDynamically && !hasClientIdentity) {
      return {
        ok: false,
        code: 'oauth-client-required',
        message: '该服务不支持自动注册客户端，请在认证方式中填写 OAuth Client ID 后重试'
      }
    }

    let capturedCode: string | null = null
    const provider = createMcpOAuthClientProvider(db, profile, {
      ...options,
      preset,
      onCode: (code) => {
        capturedCode = code
      }
    })

    // 授权服务器与 MCP 端点不同源（如 GitHub）时放行其 origin，仅限 OAuth 发现与 token 交换。
    const oauthExtraOrigins =
      serverInfo?.resourceMetadata?.authorization_servers?.length && serverInfo.authorizationServerUrl
        ? [new URL(serverInfo.authorizationServerUrl).origin]
        : await resolveOauthAuthorizationServerOrigin(endpoint).then((origin) =>
            origin ? [origin] : undefined
          )
    const buildTransport = () =>
      createStreamableHttpTransport({
        endpoint,
        authProvider: provider,
        ...(oauthExtraOrigins?.length ? { allowedExtraOrigins: oauthExtraOrigins } : {}),
        onDiagnostic: () => undefined
      })
    let transport = await buildTransport()
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    let client = new Client({ name: 'spaceassistant', version: '0.1.5' })
    try {
      await client.connect(transport)
    } catch (error) {
      if (error instanceof UnauthorizedError && capturedCode !== null) {
        await transport.finishAuth(capturedCode)
        await client.close().catch(() => undefined)
        // SDK 传输不可重复 start：携带已保存 token 重建传输后连接
        transport = await buildTransport()
        client = new Client({ name: 'spaceassistant', version: '0.1.5' })
        await client.connect(transport)
      } else {
        throw error
      }
    } finally {
      await client.close().catch(() => undefined)
    }

    updateServerStatus(db, serverId, {
      status: 'connected',
      clearLastError: true
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof OAuthCallbackTimeoutError) {
      return { ok: false, code: 'oauth-timeout', message }
    }
    return { ok: false, code: 'oauth-failed', message }
  } finally {
    activeFlows.delete(serverId)
  }
}
