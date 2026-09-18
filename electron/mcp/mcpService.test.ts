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
  /** /.well-known/oauth-protected-resource 返回 302 到该地址（评审 S5 重定向用例） */
  redirectProtectedResourceTo?: string
  /** 同源 302 → /meta/protected-resource（评审 v2 建议 2 正向用例） */
  redirectProtectedResourceSameOrigin?: boolean
}

function startMockServer(options: MockServerOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      if (req.url === '/.well-known/oauth-protected-resource') {
        if (options.redirectProtectedResourceTo) {
          res.writeHead(302, { Location: options.redirectProtectedResourceTo })
          res.end()
          return
        }
        if (options.redirectProtectedResourceSameOrigin) {
          // 同源 302：Location 指向同 server 的合法元数据路径（评审 v2 建议 2 正向链路）
          res.writeHead(302, { Location: '/meta/protected-resource' })
          res.end()
          return
        }
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
      if (req.url === '/meta/protected-resource') {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/auth-server`] }))
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

  it('已有服务时追加：既有 profile 与 secretPresent 保留（评审 B2 数据丢失用例）', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-append-')
    try {
      // 既有两个服务：一个 bearer（带 token），一个 none
      await addMcpServer(db, {
        name: '既有服务A', transport: 'http', endpoint: await startMockServer({ registrationEndpoint: true }),
        authMode: 'bearer-token', accessToken: 'existing-token-value'
      })
      await addMcpServer(db, { name: '既有服务B', transport: 'stdio', command: 'uvx', args: ['mcp-x'] })
      expect(listProfiles(db)).toHaveLength(2)

      const result = await addMcpServer(db, {
        name: '新追加服务', transport: 'http', endpoint: await startMockServer({ registrationEndpoint: true }),
        authMode: 'oauth'
      })
      expect(result.ok).toBe(true)
      const profiles = listProfiles(db)
      expect(profiles).toHaveLength(3)
      const kept = profiles.find((p) => p.name === '既有服务A')
      expect(kept?.auth.secretPresent).toBe(true) // 凭据未被清空
      expect(profiles.find((p) => p.name === '既有服务B')).toBeDefined()
    } finally {
      cleanup()
    }
  })

  it('与既有服务重名 → save-failed，不产生重复服务', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-dupname-')
    try {
      await addMcpServer(db, { name: '同名服务', transport: 'stdio', command: 'a' })
      const result = await addMcpServer(db, { name: '同名服务', transport: 'stdio', command: 'b' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('save-failed')
      expect(listProfiles(db)).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('discovery 重定向到私网 → 结论为发现被拦截，且 profile 仍保存（评审 S5）', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-ssrf-')
    try {
      const endpoint = await startMockServer({ redirectProtectedResourceTo: 'http://10.0.0.2:9/mcp' })
      const result = await addMcpServer(db, {
        name: '重定向服务', transport: 'http', endpoint, authMode: 'oauth'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.conclusion.kind).toBe('bearer-only')
      expect(result.conclusion.message).not.toContain('10.0.0.2')
      // 结论说明发现被拦截（安全策略），而非宣称服务不支持 OAuth
      expect(result.conclusion.message).toContain('安全策略')
    } finally {
      cleanup()
    }
  })

  it('discovery 同源 302 → 正常跟随并得出 DCR 结论（评审 v2 建议 2 正向链路）', async () => {
    const { db, cleanup } = createTempDatabase('mcp-add-redirect-ok-')
    try {
      const endpoint = await startMockServer({
        registrationEndpoint: true,
        redirectProtectedResourceSameOrigin: true
      })
      const result = await addMcpServer(db, {
        name: '同源跳转服务', transport: 'http', endpoint, authMode: 'oauth'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // 同源合法重定向被跟随，元数据可达 → DCR 结论成立
      expect(result.conclusion.kind).toBe('oauth-dcr')
    } finally {
      cleanup()
    }
  })

  it('并发 appendServer：Promise.all 两个 add 全部落库，既有 secret 保留（v3 评审建议 1）', async () => {
    const { db, cleanup } = createTempDatabase('mcp-append-concurrent-')
    try {
      await addMcpServer(db, {
        name: '并发既有服务', transport: 'http', endpoint: await startMockServer({ registrationEndpoint: true }),
        authMode: 'bearer-token', accessToken: 'existing-kept-token'
      })
      const endpointB = await startMockServer({ registrationEndpoint: true })
      // 同一 endpoint 无害：名称不同即可
      const [r1, r2] = await Promise.all([
        addMcpServer(db, { name: '并发A', transport: 'stdio', command: 'a' }),
        addMcpServer(db, { name: '并发B', transport: 'stdio', command: 'b' })
      ])
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      const profiles = listProfiles(db)
      const names = profiles.map((p) => p.name).sort()
      expect(names).toEqual(['并发A', '并发B', '并发既有服务'].sort())
      expect(profiles.find((p) => p.name === '并发既有服务')?.auth.secretPresent).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('safeStorage 不可用且带 secret → save-failed，不落库（评审建议 14）', async () => {
    const secureApiKey = await import('../secureApiKey')
    const spy = vi.spyOn(secureApiKey, 'isSecretStorageAvailable').mockReturnValue(false)
    try {
      const { db, cleanup } = createTempDatabase('mcp-add-nostorage-')
      try {
        const result = await addMcpServer(db, {
          name: '无存储服务', transport: 'stdio', command: 'npx', args: ['-y', 'x'],
          env: { API_TOKEN: 'tok-1' }
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('save-failed')
        expect(listProfiles(db)).toHaveLength(0)
      } finally {
        cleanup()
      }
    } finally {
      spy.mockRestore()
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
describe('withMcpSecretWriteLock 重入检测（v3 评审建议 4）', () => {
  it('临界区内重入调用立即拒绝', async () => {
    const { withMcpSecretWriteLock } = await import('./mcpSecretStore')
    await expect(
      withMcpSecretWriteLock(() =>
        withMcpSecretWriteLock(() => 'inner')
      )
    ).rejects.toThrow('MCP_SECRET_LOCK_REENTRY')
  })

  it('async 临界区挂起期间，独立并发调用正常排队而非误拒（v4 评审）', async () => {
    const { withMcpSecretWriteLock } = await import('./mcpSecretStore')
    const order: string[] = []
    const first = withMcpSecretWriteLock(async () => {
      order.push('A-start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('A-end')
      return 'A-done'
    })
    // 等 A 的回调开始执行（lockHeld=true 的窗口）后 B 才进入入口——
    // 这是 v4 评审实证的误拒形态：B 是独立调用方，必须排队而非被误报 REENTRY
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(order).toEqual(['A-start'])
    const second = withMcpSecretWriteLock(() => {
      order.push('B')
      return 'B-done'
    })
    expect(await first).toBe('A-done')
    expect(await second).toBe('B-done')
    expect(order).toEqual(['A-start', 'A-end', 'B'])
  })
})
})
