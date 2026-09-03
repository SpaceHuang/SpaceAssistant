import http from 'http'
import type { AddressInfo } from 'net'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import type { McpServerProfile } from '../../src/shared/mcpTypes'
import { listProfiles, saveProfiles } from './mcpConfigStore'
import { getSecret } from './mcpSecretStore'
import { isOAuthFlowActive, startOAuthFlow } from './mcpOauthService'

vi.mock('../secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (b64: string) => b64.replace(/^enc:/, '')
}))

const servers: Array<http.Server> = []

function startMockAuthServer(options: { rejectRefresh?: boolean; noAuthServerMetadata?: boolean } = {}): Promise<{
  endpoint: string
  receivedAuthHeaders: string[]
  setRejectAccessToken: (value: boolean) => void
}> {
  const noAuthServerMetadata = 'noAuthServerMetadata' in options ? Boolean(options.noAuthServerMetadata) : false
  const receivedAuthHeaders: string[] = []
  let rejectAccessToken = false
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      if (req.url === '/protected-resource') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            authorization_servers: [`${origin}/auth-server`],
            resource: `${origin}/mcp`
          })
        )
        return
      }
      if (req.url === '/auth-server/.well-known/oauth-authorization-server') {
        if (noAuthServerMetadata) {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: `${origin}/auth-server`,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['read']
          })
        )
        return
      }
      if (req.url === '/token') {
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk.toString('utf8')
        })
        req.on('end', () => {
          const params = new URLSearchParams(raw)
          if (params.get('grant_type') === 'refresh_token' && options.rejectRefresh) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh rejected' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              access_token: 'access-new',
              refresh_token: 'refresh-new',
              token_type: 'Bearer',
              expires_in: 3600,
              scope: 'read'
            })
          )
        })
        return
      }

      const auth = req.headers.authorization
      if (auth) receivedAuthHeaders.push(auth)
      if (!auth || (req.url === '/mcp' && rejectAccessToken)) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/protected-resource"`
        })
        res.end()
        return
      }
      if (req.method !== 'POST') {
        // Streamable HTTP 的 GET = SSE 通知流：保持连接打开
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        })
        res.write(': keepalive\n\n')
        return
      }

      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        const message = JSON.parse(raw) as { method?: string; id?: number }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (message.method === 'initialize') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'oauth-server', version: '1.0.0' }
              }
            })
          )
        } else if (message.method === 'tools/list') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: [{ name: 't', description: '', inputSchema: { type: 'object' } }] }
            })
          )
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      resolve({
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        receivedAuthHeaders,
        setRejectAccessToken: (value: boolean) => {
          rejectAccessToken = value
        }
      })
    })
  })
}

/** GitHub 形态：MCP 端点与 OAuth 授权服务器不同源。 */
function startCrossOriginServers(): Promise<{
  endpoint: string
  receivedAuthHeaders: string[]
}> {
  const receivedAuthHeaders: string[] = []
  return new Promise((resolve) => {
    let authServerUrl = ''
    const authServer = http.createServer((req, res) => {
      if (
        req.url === '/auth-server/.well-known/oauth-authorization-server' ||
        req.url === '/auth-server/.well-known/openid-configuration'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: `${authServerUrl}/auth-server`,
            authorization_endpoint: `${authServerUrl}/auth-server/authorize`,
            token_endpoint: `${authServerUrl}/auth-server/token`,
            jwks_uri: `${authServerUrl}/auth-server/jwks`,
            subject_types_supported: ['public'],
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['repo'],
            claims_supported: ['sub'],
            id_token_signing_alg_values_supported: ['RS256']
          })
        )
        return
      }
      if (req.url === '/auth-server/token') {
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk.toString('utf8')
        })
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              access_token: 'cross-origin-token',
              refresh_token: 'cross-origin-refresh',
              token_type: 'Bearer',
              expires_in: 3600
            })
          )
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    authServer.listen(0, '127.0.0.1', () => {
      authServerUrl = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`
      const mcpServer = http.createServer((req, res) => {
        if (req.url === '/protected-resource') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              authorization_servers: [`${authServerUrl}/auth-server`],
              resource: `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`
            })
          )
          return
        }
        const auth = req.headers.authorization
        if (auth) receivedAuthHeaders.push(auth)
        if (!auth) {
          const port = (mcpServer.address() as AddressInfo).port
          res.writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="http://127.0.0.1:${port}/protected-resource"`
          })
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(': keepalive\n\n')
          return
        }
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk.toString('utf8')
        })
        req.on('end', () => {
          const message = JSON.parse(raw) as { method?: string; id?: number }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          if (message.method === 'initialize') {
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  protocolVersion: '2025-06-18',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'cross-origin-server', version: '1.0.0' }
                }
              })
            )
          } else if (message.method === 'tools/list') {
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { tools: [{ name: 't', description: '', inputSchema: { type: 'object' } }] }
              })
            )
          } else {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
          }
        })
      })
      mcpServer.listen(0, '127.0.0.1', () => {
        servers.push(authServer)
        servers.push(mcpServer)
        resolve({
          endpoint: `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`,
          receivedAuthHeaders
        })
      })
    })
  })
}

afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections?.()
    server.close()
  }
})

describe('mcpOauthService', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-mcp-oauth-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  async function saveOauthProfile(endpoint: string): Promise<string> {
    await saveProfiles(db, [
      {
        id: 'server-1',
        name: 'OAuth Server',
        enabled: true,
        transport: 'streamable-http',
        timeoutSec: 60,
        auth: { mode: 'oauth', oauthClientId: 'manual-client' },
        http: { endpoint },
        enabledToolNames: ['t'],
      }
    ])
    return 'server-1'
  }

  it('completes the authorization code flow with a manual client id and stores tokens', async () => {
    const { endpoint } = await startMockAuthServer()
    const serverId = await saveOauthProfile(endpoint)

    const result = await startOAuthFlow(db, serverId, {
      authorize: async (url) => {
        expect(url.searchParams.get('client_id')).toBe('manual-client')
        expect(url.searchParams.has('code_challenge')).toBe(true)
        return 'auth-code-1'
      }
    })
    expect(result.ok).toBe(true)
    expect(await getSecret(db, serverId, 'access-token')).toBe('access-new')
    expect(await getSecret(db, serverId, 'refresh-token')).toBe('refresh-new')
    expect(listProfiles(db)[0]!.status).toBe('connected')
    expect(listProfiles(db)[0]!.auth.accessTokenExpiresAt).toBeTruthy()
  })

  it('marks auth-expired and clears tokens when refresh fails and re-auth is cancelled', async () => {
    const { endpoint, setRejectAccessToken } = await startMockAuthServer({ rejectRefresh: true })
    const serverId = await saveOauthProfile(endpoint)
    let cancelled = false

    // 首次授权成功，保存 refresh token
    const first = await startOAuthFlow(db, serverId, {
      authorize: async () => 'first-code'
    })
    expect(first.ok).toBe(true)
    expect(await getSecret(db, serverId, 'refresh-token')).toBe('refresh-new')

    // 模拟 access token 过期（服务端 401）→ SDK 触发 OAuth → refresh 被拒 →
    // invalidateCredentials（auth-expired + 清 token）→ 重试授权 → 用户取消
    setRejectAccessToken(true)
    const second = await startOAuthFlow(db, serverId, {
      authorize: async () => {
        cancelled = true
        throw new Error('user cancelled')
      }
    })
    expect(cancelled).toBe(true)
    expect(second.ok).toBe(false)
    expect(listProfiles(db)[0]!.status).toBe('auth-expired')
    expect(await getSecret(db, serverId, 'access-token')).toBeNull()
    expect(await getSecret(db, serverId, 'refresh-token')).toBeNull()
  })

  it('locks concurrent flows for the same server', async () => {
    const { endpoint } = await startMockAuthServer()
    const serverId = await saveOauthProfile(endpoint)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = startOAuthFlow(db, serverId, {
      authorize: async () => {
        await gate
        return 'code-1'
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(isOAuthFlowActive(serverId)).toBe(true)

    const second = await startOAuthFlow(db, serverId, {
      authorize: async () => 'code-2'
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('flow-active')

    release()
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(isOAuthFlowActive(serverId)).toBe(false)
  })

  it('authorizes an unsaved draft via the profile override and persists tokens', async () => {
    const { endpoint } = await startMockAuthServer()
    const draft: McpServerProfile = {
      id: 'draft-1',
      name: 'Draft',
      enabled: false,
      transport: 'streamable-http',
      timeoutSec: 60,
      auth: { mode: 'oauth', secretPresent: false, oauthClientId: 'manual-client' },
      http: { endpoint },
      enabledToolNames: [],
      status: 'untested',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z'
    }

    const result = await startOAuthFlow(db, 'draft-1', {
      profile: draft,
      authorize: async () => 'draft-code'
    })
    expect(result.ok).toBe(true)
    expect(await getSecret(db, 'draft-1', 'access-token')).toBe('access-new')
    expect(await getSecret(db, 'draft-1', 'refresh-token')).toBe('refresh-new')
  })

  it('requires a manual client id when the server cannot register clients', async () => {
    const { endpoint } = await startMockAuthServer({ noAuthServerMetadata: true })
    await saveProfiles(db, [
      {
        id: 'github-like',
        name: 'GitHub-like',
        enabled: true,
        transport: 'streamable-http',
        timeoutSec: 60,
        auth: { mode: 'oauth' },
        http: { endpoint },
        enabledToolNames: [],
      }
    ])

    const result = await startOAuthFlow(db, 'github-like', {
      authorize: async () => 'code'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('oauth-client-required')
      expect(result.message).toContain('http://127.0.0.1:42188/callback')
      expect(result.message).toContain('Bearer token')
    }
  })

  it('times out while waiting for the loopback callback', async () => {
    const { endpoint } = await startMockAuthServer()
    const serverId = await saveOauthProfile(endpoint)

    const result = await startOAuthFlow(db, serverId, {
      loopbackPort: 0,
      callbackTimeoutMs: 100,
      openBrowser: async () => undefined
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('oauth-timeout')
  })

  it('completes OAuth against a cross-origin authorization server (GitHub-like)', async () => {
    const { endpoint, receivedAuthHeaders } = await startCrossOriginServers()
    const serverId = await saveOauthProfile(endpoint)

    const result = await startOAuthFlow(db, serverId, {
      authorize: async () => 'cross-code'
    })
    expect(result.ok).toBe(true)
    expect(await getSecret(db, serverId, 'access-token')).toBe('cross-origin-token')
    expect(receivedAuthHeaders).toContain('Bearer cross-origin-token')
  })
})
