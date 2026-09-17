import http from 'http'
import type { AddressInfo } from 'net'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../../database'
import { createTempDatabase } from '../../database/testHelpers'
import { listProfiles } from '../../mcp/mcpConfigStore'
import { createMcpCapabilities } from './mcp'
import { callCapability } from '../callCapability'
import { CapabilityRegistry } from '../registry'
import type { CapabilityContext } from '../types'

vi.mock('../../secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (b64: string) => b64.replace(/^enc:/, '')
}))

const servers: Array<http.Server> = []

afterAll(() => {
  for (const server of servers.splice(0)) server.close()
})

function startDcrMockServer(): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      if (req.url === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/auth-server`] }))
        return
      }
      if (
        req.url === '/auth-server/.well-known/oauth-authorization-server' ||
        req.url === '/.well-known/oauth-authorization-server/auth-server'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: `${origin}/auth-server`,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256']
          })
        )
        return
      }
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

function makeCtx(db: AppDatabase): CapabilityContext {
  return {
    workDir: '/work',
    userDataDir: '/user',
    sessionId: 's1',
    requestId: 'r1',
    signal: new AbortController().signal,
    appDatabase: db
  }
}

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry()
  for (const cap of createMcpCapabilities()) registry.register(cap)
  return registry
}

describe('action.mcp.add 能力', () => {
  it('act 能力未经确认 → denied；经确认 → 完成添加并返回 DCR 结论', async () => {
    const { db, cleanup } = createTempDatabase('cap-mcp-add-')
    try {
      const endpoint = await startDcrMockServer()
      const registry = makeRegistry()
      const params = { name: '测试服务', transport: 'http', endpoint, authMode: 'oauth' }

      const denied = await callCapability(registry, 'action.mcp.add', params, makeCtx(db), { allowed: false })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.error.code).toBe('denied')
      expect(listProfiles(db)).toHaveLength(0)

      const allowed = await callCapability(registry, 'action.mcp.add', params, makeCtx(db), { allowed: true })
      expect(allowed.ok).toBe(true)
      if (!allowed.ok) return
      const data = allowed.data as { ok: boolean; conclusion: { kind: string }; guide: string }
      expect(data.ok).toBe(true)
      expect(data.conclusion.kind).toBe('oauth-dcr')
      expect(data.guide).toContain('设置页')
      expect(listProfiles(db)).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('参数校验：未知 transport / 缺 endpoint → invalid-params（不落库）', async () => {
    const { db, cleanup } = createTempDatabase('cap-mcp-invalid-')
    try {
      const registry = makeRegistry()
      for (const badParams of [
        { name: 'x', transport: 'ftp', endpoint: 'https://example.com/mcp' },
        { name: 'x', transport: 'http' },
        { name: 'x', transport: 'stdio' }
      ]) {
        const result = await callCapability(registry, 'action.mcp.add', badParams, makeCtx(db), { allowed: true })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.code).toBe('invalid-params')
      }
      expect(listProfiles(db)).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  it('成功结果零凭据泄漏（含 token 形态字段）', async () => {
    const { db, cleanup } = createTempDatabase('cap-mcp-secret-')
    try {
      const endpoint = await startDcrMockServer()
      const registry = makeRegistry()
      const result = await callCapability(
        registry,
        'action.mcp.add',
        { name: '带密钥服务', transport: 'http', endpoint, authMode: 'bearer-token', accessToken: 'sk-ant-secret-value-123' },
        makeCtx(db),
        { allowed: true }
      )
      expect(result.ok).toBe(true)
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('sk-ant-secret-value-123')
      const profile = listProfiles(db).find((p) => p.name === '带密钥服务')
      expect(profile?.auth.secretPresent).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('paramsSchema superRefine：http 缺 endpoint 报 endpoint 字段错误', () => {
    const schema = createMcpCapabilities()[0]!.paramsSchema
    const parsed = schema.safeParse({ name: 'x', transport: 'http' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes('endpoint'))).toBe(true)
    }
  })
})
