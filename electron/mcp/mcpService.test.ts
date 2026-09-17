import http from 'http'
import type { AddressInfo } from 'net'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import { listProfiles } from './mcpConfigStore'
import { addMcpServer } from './mcpService'
import type { McpOAuthClientPreset } from './oauthClientPresets'

vi.mock('../secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (b64: string) => b64.replace(/^enc:/, '')
}))

const servers: Array<http.Server> = []

afterAll(() => {
  for (const server of servers.splice(0)) server.close()
})

interface MockServerOptions {
  registrationEndpoint?: boolean
  noAuthServerMetadata?: boolean
  noProtectedResource?: boolean
}

function startMockServer(options: MockServerOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      if (req.url === '/.well-known/oauth-protected-resource') {
        if (options.noProtectedResource) {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            resource: `${origin}/mcp`,
            authorization_servers: [`${origin}/auth-server`]
          })
        )
        return
      }
      if (
        req.url === '/auth-server/.well-known/oauth-authorization-server' ||
        req.url === '/.well-known/oauth-authorization-server/auth-server'
      ) {
        if (options.noAuthServerMetadata) {
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
            ...(options.registrationEndpoint ? { registration_endpoint: `${origin}/register` } : {}),
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256']
          })
        )
        return
      }
      // MCP 端点：恒 401（add 只做 discovery，不发起授权/连接）
      res.writeHead(401, {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
      })
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
    })
  })
}

describe('mcpService.addMcpServer 三态结论（需求 §7 Phase 2 / 前案 §5.2.2）', () => {
  it('支持 DCR：authorization server 元数据含 registration_endpoint → oauth-dcr，profile 已保存', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-dcr-')
    try {
      const endpoint = await startMockServer({ registrationEndpoint: true })
      const result = await addMcpServer(db, {
        name: 'dcr 服务',
        transport: 'http',
        endpoint,
        authMode: 'oauth'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.conclusion.kind).toBe('oauth-dcr')
      expect(result.guide).toContain('设置页')
      const profiles = listProfiles(db)
      expect(profiles.find((p) => p.id === result.serverId)).toMatchObject({ name: 'dcr 服务', enabled: true })
      // 不回显任何凭据形态字段
      expect(JSON.stringify(result)).not.toContain('accessToken')
    } finally {
      cleanup()
    }
  })

  it('无 DCR 仅预设：元数据无 registration_endpoint 但命中预设 → oauth-client-id(presetMatched)', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-preset-')
    try {
      const endpoint = await startMockServer({ registrationEndpoint: false })
      const preset: McpOAuthClientPreset = {
        presetId: 'test-preset',
        displayName: '测试预设',
        serverOrigin: '', // 运行时由 startMockServer 后填 origin
        issuer: '',
        clientId: 'preset-client-id',
        allowedScopes: ['read'],
        redirectUriPolicy: 'loopback'
      }
      // 先探测端口的 origin
      const probe = new URL(endpoint)
      const base = `${probe.protocol}//${probe.host}`
      preset.serverOrigin = base
      preset.issuer = `${base}/auth-server`
      const result = await addMcpServer(
        db,
        { name: 'preset 服务', transport: 'http', endpoint, authMode: 'oauth' },
        { presets: [preset] }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.conclusion.kind).toBe('oauth-client-id')
      if (result.conclusion.kind === 'oauth-client-id') {
        expect(result.conclusion.presetMatched).toBe(true)
      }
    } finally {
      cleanup()
    }
  })

  it('不支持 OAuth：无授权服务器元数据 → bearer-only', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-bearer-')
    try {
      const endpoint = await startMockServer({ noAuthServerMetadata: true, noProtectedResource: true })
      const result = await addMcpServer(db, {
        name: 'bearer 服务',
        transport: 'http',
        endpoint,
        authMode: 'bearer-token',
        accessToken: 'sk-test-token'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.conclusion.kind).toBe('bearer-only')
      // 传入的 accessToken 不回显
      expect(JSON.stringify(result)).not.toContain('sk-test-token')
      const profiles = listProfiles(db)
      const profile = profiles.find((p) => p.name === 'bearer 服务')
      expect(profile?.auth.secretPresent).toBe(true) // 存在性旗标，非明文
    } finally {
      cleanup()
    }
  })

  it('无 DCR 且无预设且无 Client ID → oauth-client-id(presetMatched:false, clientIdProvided:false)', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-noclient-')
    try {
      const endpoint = await startMockServer({ registrationEndpoint: false })
      const result = await addMcpServer(db, {
        name: '手工服务',
        transport: 'http',
        endpoint,
        authMode: 'oauth'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.conclusion.kind).toBe('oauth-client-id')
      if (result.conclusion.kind === 'oauth-client-id') {
        expect(result.conclusion.presetMatched).toBe(false)
        expect(result.conclusion.clientIdProvided).toBe(false)
      }
    } finally {
      cleanup()
    }
  })

  it('私网 endpoint 被 endpointPolicy 拒绝且不落库', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-private-')
    try {
      const result = await addMcpServer(db, {
        name: '私网服务',
        transport: 'http',
        endpoint: 'http://10.0.0.5:3000/mcp',
        authMode: 'oauth'
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('endpoint-policy-blocked')
      expect(listProfiles(db)).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  it('stdio 服务：保存 command/args/env，env secret 落存在性旗标', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-stdio-')
    try {
      const result = await addMcpServer(db, {
        name: 'stdio 服务',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-mcp-server'],
        env: { API_TOKEN: 'tok-123' }
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(JSON.stringify(result)).not.toContain('tok-123')
      const profile = listProfiles(db).find((p) => p.name === 'stdio 服务')
      expect(profile?.stdio).toMatchObject({ command: 'npx', args: ['-y', 'some-mcp-server'] })
      expect(profile?.stdio?.env[0]).toMatchObject({ key: 'API_TOKEN', valuePresent: true })
    } finally {
      cleanup()
    }
  })
})
