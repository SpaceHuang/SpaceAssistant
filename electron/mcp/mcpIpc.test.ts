import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import type { AppDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import type { McpServerWriteInput } from '../../src/shared/mcpTypes'
import { appendDiagnostic } from './mcpDiagnostics'
import { listProfiles } from './mcpConfigStore'
import { registerMcpIpcHandlers } from './mcpIpc'
import * as mcpOauthService from './mcpOauthService'
import { setSecret } from './mcpSecretStore'

vi.mock('../secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (b64: string) => b64.replace(/^enc:/, '')
}))

type HandlerMap = Record<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>

function createFakeIpcMain(): { ipcMain: IpcMain; handlers: HandlerMap } {
  const handlers: HandlerMap = {}
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = fn
    }
  } as unknown as IpcMain
  return { ipcMain, handlers }
}

function makeInput(overrides: Partial<McpServerWriteInput> = {}): McpServerWriteInput {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'GitHub',
    enabled: false,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none' },
    stdio: { command: 'node', args: ['server.js'], env: [] },
    enabledToolNames: [],
    ...overrides
  }
}

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const httpServers: Array<http.Server> = []
function startAuthRequiredHttpServer(): Promise<{
  endpoint: string
  receivedAuthHeaders: string[]
}> {
  const receivedAuthHeaders: string[] = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization
      if (auth) receivedAuthHeaders.push(auth)
      if (!auth) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Bearer resource_metadata="http://127.0.0.1:1/.well-known/oauth-protected-resource"'
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
                serverInfo: { name: 'ipc-oauth', version: '1.0.0' }
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
      httpServers.push(server)
      resolve({
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        receivedAuthHeaders
      })
    })
  })
}

/** 可定制 tools/list 返回的工具名（自动回填白名单用例）。 */
function startToolsListServer(toolNames: string[]): Promise<{ endpoint: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
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
                serverInfo: { name: 'ipc-autofill', version: '1.0.0' }
              }
            })
          )
        } else if (message.method === 'tools/list') {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: toolNames.map((name) => ({ name, description: '', inputSchema: { type: 'object' } })) }
            })
          )
        } else {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      httpServers.push(server)
      resolve({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` })
    })
  })
}

/**
 * OAuth 全链路 mock：access token 一律 401，refresh 恒返回 invalid_grant——
 * 用于验证后台路径（refresh-tools / test-connection）在 token 失效时不弹浏览器授权，
 * 而是返回结构化 auth-required。
 */
function startExpiredOAuthMockServer(): Promise<{ endpoint: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      if (req.url === '/protected-resource') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ authorization_servers: [`${origin}/auth-server`], resource: `${origin}/mcp` }))
        return
      }
      if (req.url === '/auth-server/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: `${origin}/auth-server`,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256']
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
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh rejected' }))
        })
        return
      }
      // MCP 端点：带不带 token 都 401（token 已失效）
      res.writeHead(401, {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/protected-resource"`
      })
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      httpServers.push(server)
      resolve({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` })
    })
  })
}

afterAll(() => {
  for (const server of httpServers) {
    server.closeAllConnections?.()
    server.close()
  }
})

describe('mcp IPC handlers', () => {
  let db: AppDatabase
  let cleanup: () => void
  let handlers: HandlerMap

  beforeEach(() => {
    const temp = createTempDatabase('sa-mcp-ipc-')
    db = temp.db
    cleanup = temp.cleanup
    const fake = createFakeIpcMain()
    registerMcpIpcHandlers(fake.ipcMain, { db } as never)
    handlers = fake.handlers
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it('mcp:list returns stored profiles', async () => {
    await handlers['mcp:save-profiles']!(null, { servers: [makeInput()] })
    const result = (await handlers['mcp:list']!(null)) as { servers: unknown[] }
    expect(result.servers).toHaveLength(1)
  })

  it('mcp:save-profiles persists secrets without returning them', async () => {
    const result = (await handlers['mcp:save-profiles']!(null, {
      servers: [makeInput({ auth: { mode: 'bearer-token', accessToken: 'ghp_secret' } })]
    })) as { servers: Array<{ auth: { secretPresent: boolean } }> }
    expect(result.servers[0]!.auth.secretPresent).toBe(true)
    expect(JSON.stringify(result)).not.toContain('ghp_secret')
    expect(JSON.stringify(result)).not.toContain('enc:')
  })

  it('mcp:save-profiles rejects unknown fields (strict)', async () => {
    await expect(
      handlers['mcp:save-profiles']!(null, {
        servers: [{ ...makeInput(), status: 'connected' }]
      })
    ).rejects.toThrow()
  })

  it('mcp:clear-secret removes the token and returns fresh profiles', async () => {
    await handlers['mcp:save-profiles']!(null, {
      servers: [makeInput({ auth: { mode: 'bearer-token', accessToken: 'tok' } })]
    })
    const result = (await handlers['mcp:clear-secret']!(null, {
      serverId: makeInput().id,
      kind: 'access-token'
    })) as { servers: Array<{ auth: { secretPresent: boolean } }> }
    expect(result.servers[0]!.auth.secretPresent).toBe(false)
  })

  it('mcp:delete-server removes the profile', async () => {
    await handlers['mcp:save-profiles']!(null, { servers: [makeInput()] })
    await handlers['mcp:delete-server']!(null, { serverId: makeInput().id })
    const result = (await handlers['mcp:list']!(null)) as { servers: unknown[] }
    expect(result.servers).toEqual([])
  })

  it('mcp:get-diagnostics returns stored sanitized entries', async () => {
    await appendDiagnostic(db, makeInput().id, { code: 'init_failed', message: 'boom sk-ant-api03-xyz' })
    const result = (await handlers['mcp:get-diagnostics']!(null, {
      serverId: makeInput().id
    })) as { diagnostics: Array<{ code: string; message: string }> }
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]!.message).not.toContain('sk-ant-api03-xyz')
  })

  it('mcp:test-connection connects to a real stdio server and maps tools', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mcp-ipc-conn-'))
    tempDirs.push(dir)
    const scriptPath = path.join(dir, 'server.js')
    fs.writeFileSync(
      scriptPath,
      `
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'ipc-server', version: '1.0.0' }
    }})
  } else if (req.method === 'notifications/initialized') {
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [
      { name: 'hello', description: 'says hello', inputSchema: { type: 'object' } }
    ]}})
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
  }
})
`,
      'utf8'
    )

    const result = (await handlers['mcp:test-connection']!(null, {
      server: makeInput({ stdio: { command: process.execPath, args: [scriptPath], env: [] } })
    })) as { ok: boolean; serverName?: string; tools?: Array<{ mappedName: string }>; message?: string }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.serverName).toBe('ipc-server')
      expect(result.tools?.[0]?.mappedName).toMatch(/^mcp_github_hello_[0-9a-f]{8}$/)
    }
  })

  it('mcp:oauth-start returns not-found for an unknown server', async () => {
    const result = (await handlers['mcp:oauth-start']!(null, {
      serverId: 'missing-server'
    })) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-found')
  })

  it('mcp:test-connection sends the OAuth token for an already-authorized draft', async () => {
    const { endpoint, receivedAuthHeaders } = await startAuthRequiredHttpServer()
    const draft = makeInput({
      id: 'oauth-draft',
      transport: 'streamable-http',
      stdio: undefined,
      http: { endpoint },
      auth: { mode: 'oauth', oauthClientId: 'manual-client' }
    })
    await setSecret(db, 'oauth-draft', 'access-token', 'oauth-token')
    const spy = vi.spyOn(mcpOauthService, 'startOAuthFlow')

    const result = (await handlers['mcp:test-connection']!(null, {
      server: draft
    })) as { ok: boolean; serverName?: string; tools?: Array<{ mappedName: string }> }

    expect(spy).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.serverName).toBe('ipc-oauth')
      expect(result.tools?.[0]?.mappedName).toMatch(/^mcp_/)
    }
    expect(receivedAuthHeaders).toContain('Bearer oauth-token')
  })

  it('mcp:test-connection starts OAuth for a draft without a token and surfaces failures', async () => {
    const { endpoint } = await startAuthRequiredHttpServer()
    const draft = makeInput({
      id: 'oauth-draft-2',
      transport: 'streamable-http',
      stdio: undefined,
      http: { endpoint },
      auth: { mode: 'oauth', oauthClientId: 'manual-client' }
    })
    const spy = vi.spyOn(mcpOauthService, 'startOAuthFlow').mockResolvedValue({
      ok: false,
      code: 'oauth-client-required',
      message: '需要 Client ID'
    })

    const result = (await handlers['mcp:test-connection']!(null, {
      server: draft
    })) as { ok: boolean; code?: string; message?: string }

    expect(spy).toHaveBeenCalledWith(db, 'oauth-draft-2', expect.objectContaining({ profile: expect.anything() }))
    expect(result).toEqual({ ok: false, code: 'oauth-client-required', message: '需要 Client ID' })
  })

  it('mcp:test-connection falls back to the saved bearer token when the draft leaves it blank', async () => {
    const { endpoint, receivedAuthHeaders } = await startAuthRequiredHttpServer()
    const draft = makeInput({
      id: 'saved-bearer',
      transport: 'streamable-http',
      stdio: undefined,
      http: { endpoint },
      auth: { mode: 'bearer-token' }
    })
    await setSecret(db, 'saved-bearer', 'access-token', 'saved-pat')

    const result = (await handlers['mcp:test-connection']!(null, {
      server: draft
    })) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(receivedAuthHeaders).toContain('Bearer saved-pat')
  })

  describe('mcp:refresh-tools 自动回填白名单', () => {
    function makeHttpInput(id: string, endpoint: string, overrides: Partial<McpServerWriteInput> = {}): McpServerWriteInput {
      return makeInput({
        id,
        name: `srv-${id}`,
        enabled: true,
        transport: 'streamable-http',
        stdio: undefined,
        http: { endpoint },
        auth: { mode: 'none' },
        enabledToolNames: [],
        ...overrides
      })
    }

    async function savedEnabledToolNames(id: string): Promise<string[]> {
      const servers = listProfiles(db)
      return servers.find((p) => p.id === id)?.enabledToolNames ?? []
    }

    it('enabled 且白名单为空 → 刷新成功后自动回填全部已发现工具', async () => {
      const { endpoint } = await startToolsListServer(['alpha', 'beta'])
      await handlers['mcp:save-profiles']!(null, {
        servers: [makeHttpInput('autofill-empty', endpoint)]
      })

      const result = (await handlers['mcp:refresh-tools']!(null, { serverId: 'autofill-empty' })) as {
        ok: boolean
        autoEnabledToolCount?: number
      }
      expect(result.ok).toBe(true)
      expect(await savedEnabledToolNames('autofill-empty')).toEqual(['alpha', 'beta'])
      // 回填告知标记：供 UI 提示「已自动启用 N 个工具」，避免静默改库
      expect(result.autoEnabledToolCount).toBe(2)
    })

    it('enabled 且白名单为空但本次发现 0 工具 → 不回填也不带标记', async () => {
      const { endpoint } = await startToolsListServer([])
      await handlers['mcp:save-profiles']!(null, {
        servers: [makeHttpInput('autofill-no-tools', endpoint)]
      })

      const result = (await handlers['mcp:refresh-tools']!(null, { serverId: 'autofill-no-tools' })) as {
        ok: boolean
        autoEnabledToolCount?: number
      }
      expect(result.ok).toBe(true)
      expect(await savedEnabledToolNames('autofill-no-tools')).toEqual([])
      expect(result.autoEnabledToolCount).toBeUndefined()
    })

    it('白名单非空 → 保留用户选择，不覆盖', async () => {
      const { endpoint } = await startToolsListServer(['alpha', 'beta'])
      await handlers['mcp:save-profiles']!(null, {
        servers: [makeHttpInput('autofill-kept', endpoint, { enabledToolNames: ['alpha'] })]
      })

      const result = (await handlers['mcp:refresh-tools']!(null, { serverId: 'autofill-kept' })) as { ok: boolean }
      expect(result.ok).toBe(true)
      expect(await savedEnabledToolNames('autofill-kept')).toEqual(['alpha'])
    })

    it('enabled=false → 不回填', async () => {
      const { endpoint } = await startToolsListServer(['alpha', 'beta'])
      await handlers['mcp:save-profiles']!(null, {
        servers: [makeHttpInput('autofill-disabled', endpoint, { enabled: false })]
      })

      const result = (await handlers['mcp:refresh-tools']!(null, { serverId: 'autofill-disabled' })) as { ok: boolean }
      expect(result.ok).toBe(true)
      expect(await savedEnabledToolNames('autofill-disabled')).toEqual([])
    })
  })

  describe('OAuth token 失效时后台路径不弹浏览器授权', () => {
    function makeOauthInput(id: string, endpoint: string): McpServerWriteInput {
      return makeInput({
        id,
        name: `srv-${id}`,
        enabled: true,
        transport: 'streamable-http',
        stdio: undefined,
        http: { endpoint },
        auth: { mode: 'oauth', oauthClientId: 'manual-client' },
        enabledToolNames: []
      })
    }

    async function saveExpiredOauthServer(id: string, endpoint: string): Promise<void> {
      await handlers['mcp:save-profiles']!(null, { servers: [makeOauthInput(id, endpoint)] })
      await setSecret(db, id, 'access-token', 'expired-token')
      await setSecret(db, id, 'refresh-token', 'stale-refresh-token')
    }

    it('mcp:refresh-tools → auth-required，状态置为需要授权', async () => {
      const { endpoint } = await startExpiredOAuthMockServer()
      await saveExpiredOauthServer('oauth-expired', endpoint)

      const result = (await handlers['mcp:refresh-tools']!(null, { serverId: 'oauth-expired' })) as {
        ok: boolean
        code?: string
        message?: string
      }
      expect(result.ok).toBe(false)
      expect(result.code).toBe('auth-required')
      expect(result.message).toContain('连接账户')

      const servers = listProfiles(db)
      expect(servers[0]!.status).toBe('auth-required')
      expect(servers[0]!.lastError?.code).toBe('auth-required')
    })

    it('mcp:test-connection → auth-required（已有 token 但失效，不再静默走交互授权）', async () => {
      const { endpoint } = await startExpiredOAuthMockServer()
      const input = makeOauthInput('oauth-expired-conn', endpoint)
      await setSecret(db, input.id, 'access-token', 'expired-token')
      await setSecret(db, input.id, 'refresh-token', 'stale-refresh-token')

      const result = (await handlers['mcp:test-connection']!(null, { server: input })) as {
        ok: boolean
        code?: string
        message?: string
      }
      expect(result.ok).toBe(false)
      expect(result.code).toBe('auth-required')
      expect(result.message).toContain('连接账户')
    })
  })
})
