import http from 'http'
import type { AddressInfo } from 'net'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../../database'
import { createTempDatabase } from '../../database/testHelpers'
import { listProfiles, saveProfiles, saveToolCache, updateServerStatus } from '../../mcp/mcpConfigStore'
import { setSecret } from '../../mcp/mcpSecretStore'
import type { McpServerWriteInput } from '../../../src/shared/mcpTypes'
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

  it('stdio + env 端到端：经 callCapability 落库为存在性旗标，结果零凭据（评审建议 14）', async () => {
    const { db, cleanup } = createTempDatabase('cap-mcp-stdio-')
    try {
      const registry = makeRegistry()
      const result = await callCapability(
        registry,
        'action.mcp.add',
        { name: 'stdio能力服务', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { SECRET_KEY: 'plain-secret-xyz', DEBUG: '1' } },
        makeCtx(db),
        { allowed: true }
      )
      expect(result.ok).toBe(true)
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('plain-secret-xyz')
      const profile = listProfiles(db).find((p) => p.name === 'stdio能力服务')
      expect(profile?.stdio?.env).toEqual([
        { key: 'SECRET_KEY', valuePresent: true },
        { key: 'DEBUG', valuePresent: true }
      ])
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

function makeWriteInput(overrides: Partial<McpServerWriteInput> = {}): McpServerWriteInput {
  return {
    id: 'aaaaaaaa-1111-4222-8333-444444444444',
    name: '正常服务',
    enabled: true,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none' },
    stdio: { command: 'node', args: ['server.js'], env: [] },
    enabledToolNames: [],
    ...overrides
  }
}

function writeToolCache(db: AppDatabase, serverId: string, originalNames: string[]): void {
  saveToolCache(db, serverId, {
    tools: originalNames.map((name, i) => ({
      serverId,
      originalName: name,
      mappedName: `mcp_x_${name}_${String(i).padStart(8, '0')}`,
      description: '',
      inputSchema: { type: 'object' },
      discoveredAt: new Date().toISOString()
    })),
    protocolVersion: '2025-06-18',
    discoveredAt: new Date().toISOString()
  })
}

describe('action.mcp.list 能力', () => {
  it('read 免确认：返回服务概要；「已启用但 0 工具白名单」给出自诊断 hint', async () => {
    const { db, cleanup } = createTempDatabase('cap-mcp-list-')
    try {
      await saveProfiles(db, [
        makeWriteInput({ id: 'srv-ok', name: '正常服务', enabledToolNames: ['t1'] }),
        makeWriteInput({
          id: 'srv-empty',
          name: '空白名单服务',
          transport: 'streamable-http',
          stdio: undefined,
          http: { endpoint: 'https://example.com/mcp' },
          enabled: true,
          enabledToolNames: []
        })
      ] as McpServerWriteInput[])
      writeToolCache(db, 'srv-ok', ['t1', 't2'])
      writeToolCache(db, 'srv-empty', ['search', 'read'])

      const registry = makeRegistry()
      // allowed:false——read 能力免确认，必须照常执行
      const result = await callCapability(registry, 'action.mcp.list', {}, makeCtx(db), { allowed: false })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const data = result.data as {
        servers: Array<{
          id: string
          name: string
          enabled: boolean
          status: string
          discoveredToolCount?: number
          enabledToolCount: number
          enabledToolNames: string[]
          hint?: string
        }>
      }
      expect(data.servers).toHaveLength(2)

      const ok = data.servers.find((s) => s.id === 'srv-ok')!
      expect(ok.enabled).toBe(true)
      expect(ok.discoveredToolCount).toBe(2)
      expect(ok.enabledToolCount).toBe(1)
      expect(ok.enabledToolNames).toEqual(['t1'])
      expect(ok.hint).toBeUndefined()

      const empty = data.servers.find((s) => s.id === 'srv-empty')!
      expect(empty.discoveredToolCount).toBe(2)
      expect(empty.enabledToolCount).toBe(0)
      expect(empty.hint).toBeDefined()
      expect(empty.hint).toContain('未启用')
      expect(empty.hint).toContain('设置页')
    } finally {
      cleanup()
    }
  })

  it('lastError 只出结构化 code，不透出 message（防 endpoint 泄漏与远端可控文本入模型上下文）', async () => {
    const { db, cleanup } = createTempDatabase('cap-mcp-list-lasterror-')
    try {
      await saveProfiles(db, [
        makeWriteInput({
          id: 'srv-err',
          name: '报错服务',
          transport: 'streamable-http',
          stdio: undefined,
          http: { endpoint: 'https://leaky.example.com/mcp' },
          enabledToolNames: []
        }) as McpServerWriteInput
      ])
      // 模拟真实链路：lastError.message 为原始 error.message（getaddrinfo/URL 形态）
      await updateServerStatus(db, 'srv-err', {
        lastError: {
          code: 'refresh-failed',
          message: 'getaddrinfo ENOTFOUND leaky.example.com; discovery failed at https://auth.leaky.example.com',
          occurredAt: new Date().toISOString()
        }
      })

      const registry = makeRegistry()
      const result = await callCapability(registry, 'action.mcp.list', {}, makeCtx(db), { allowed: true })
      expect(result.ok).toBe(true)
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('getaddrinfo')
      expect(serialized).not.toContain('leaky.example.com')
      expect(serialized).toContain('"lastError":{"code":"refresh-failed"}')
    } finally {
      cleanup()
    }
  })

  it('paramsSchema strict：未知参数 → invalid-params（暴露模型错误调用）', async () => {
    const { db, cleanup } = createTempDatabase('cap-mcp-list-strict-')
    try {
      const registry = makeRegistry()
      const result = await callCapability(registry, 'action.mcp.list', { serverId: 'x' }, makeCtx(db), {
        allowed: true
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('invalid-params')
    } finally {
      cleanup()
    }
  })

  it('结果零凭据泄漏（不返回 endpoint 与任何 token 值）', async () => {
    const { db, cleanup } = createTempDatabase('cap-mcp-list-secret-')
    try {
      await saveProfiles(db, [
        makeWriteInput({
          id: 'srv-secret',
          name: '带凭据服务',
          transport: 'streamable-http',
          stdio: undefined,
          http: { endpoint: 'https://secret-endpoint.example.com/mcp' },
          auth: { mode: 'bearer-token', accessToken: 'sk-list-secret-value-123' }
        })
      ])
      await setSecret(db, 'srv-secret', 'access-token', 'sk-stored-secret-456')

      const registry = makeRegistry()
      const result = await callCapability(registry, 'action.mcp.list', {}, makeCtx(db), { allowed: true })
      expect(result.ok).toBe(true)
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('sk-list-secret-value-123')
      expect(serialized).not.toContain('sk-stored-secret-456')
      expect(serialized).not.toContain('secret-endpoint.example.com')
    } finally {
      cleanup()
    }
  })

  it('缺数据库上下文 → failed', async () => {
    const registry = makeRegistry()
    const result = await callCapability(registry, 'action.mcp.list', {}, makeCtx(undefined as unknown as AppDatabase), { allowed: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('failed')
  })
})
