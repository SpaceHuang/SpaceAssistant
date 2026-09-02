import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { McpServerProfile } from '../../src/shared/mcpTypes'
import { McpConnectionManager, testConnection } from './mcpConnectionManager'

function makeProfile(overrides: Partial<McpServerProfile> = {}): McpServerProfile {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Test Server',
    enabled: false,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none', secretPresent: false },
    stdio: { command: process.execPath, args: [], env: [] },
    enabledToolNames: [],
    status: 'untested',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides
  }
}

function writeServerScript(dir: string, name: string, behavior: string): string {
  const scriptPath = path.join(dir, name)
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
      capabilities: ${behavior},
      serverInfo: { name: 'test-server', version: '1.0.0' }
    }})
  } else if (req.method === 'notifications/initialized') {
    // no reply
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [
      { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: {} } }
    ]}})
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
  }
})
`,
    'utf8'
  )
  return scriptPath
}

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
                serverInfo: { name: 'oauth-http', version: '1.0.0' }
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
        receivedAuthHeaders
      })
    })
  })
}

function makeOauthProvider(accessToken: string): OAuthClientProvider {
  return {
    get redirectUrl() {
      return 'http://127.0.0.1:1/callback'
    },
    get clientMetadata() {
      return {}
    },
    state: () => 'state',
    clientInformation: async () => ({ client_id: 'manual-client' }),
    saveClientInformation: () => undefined,
    tokens: async () => ({ access_token: accessToken, token_type: 'Bearer' }),
    saveTokens: async () => undefined,
    invalidateCredentials: async () => undefined,
    redirectToAuthorization: async () => {
      throw new Error('not expected')
    },
    saveCodeVerifier: () => undefined,
    codeVerifier: async () => ''
  }
}

function startLegacySseServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      const { port } = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}/sse`)
    })
  })
}

const servers: Array<http.Server> = []

afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections?.()
    server.close()
  }
})

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mcp-conn-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('testConnection (stdio)', () => {
  it('connects, initializes and discovers tools', async () => {
    const dir = makeTempDir()
    const script = writeServerScript(dir, 'server.js', '{ tools: {} }')
    const profile = makeProfile({ stdio: { command: process.execPath, args: [script], env: [] } })

    const result = await testConnection(profile, { connectTimeoutMs: 8000 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.serverInfo.name).toBe('test-server')
      expect(result.protocolVersion).toBe('2025-06-18')
      expect(result.tools[0]!.name).toBe('echo')
    }
  })

  it('fails with a timeout when initialize never completes', async () => {
    const dir = makeTempDir()
    const scriptPath = path.join(dir, 'silent.js')
    fs.writeFileSync(
      scriptPath,
      `
const readline = require('readline')
readline.createInterface({ input: process.stdin })
// never respond
`,
      'utf8'
    )
    const profile = makeProfile({ stdio: { command: process.execPath, args: [scriptPath], env: [] } })

    const result = await testConnection(profile, { connectTimeoutMs: 400 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toMatch(/timeout|TIMEOUT|timeout/i)
    }
  })
})

describe('McpConnectionManager', () => {
  it('records a compatibility diagnostic for unsupported server capabilities', async () => {
    const dir = makeTempDir()
    const script = writeServerScript(dir, 'elicitation.js', '{ tools: {}, elicitation: {} }')
    const profile = makeProfile({ stdio: { command: process.execPath, args: [script], env: [] } })
    const appendDiagnostic = vi.fn()
    const manager = new McpConnectionManager({ appendDiagnostic })

    const session = await manager.connect(profile, { connectTimeoutMs: 8000 })
    expect(session.info.name).toBe('test-server')
    await manager.disconnect(profile.id)

    expect(appendDiagnostic).toHaveBeenCalledWith(
      profile.id,
      expect.objectContaining({ code: 'capability-unsupported' })
    )
  })

  it('reuses a live session and restarts after process exit', async () => {
    const dir = makeTempDir()
    const scriptPath = path.join(dir, 'shortlived.js')
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
      serverInfo: { name: 'short-lived', version: '1.0.0' }
    }})
    setTimeout(() => process.exit(0), 100)
  } else if (req.method === 'notifications/initialized') {
    // no reply
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [] } })
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
  }
})
`,
      'utf8'
    )
    const profile = makeProfile({ stdio: { command: process.execPath, args: [scriptPath], env: [] } })
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })

    const first = await manager.connect(profile, {})
    expect(first.info.name).toBe('short-lived')
    const reused = await manager.connect(profile, {})
    expect(reused).toBe(first)

    // 等待进程退出，标记会话失效
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(manager.isSessionAlive(profile.id)).toBe(false)

    const restarted = await manager.connect(profile, {})
    expect(restarted).not.toBe(first)
    expect(restarted.info.name).toBe('short-lived')
    await manager.disconnect(profile.id)
  })

  it('records a transport-closed diagnostic with the last stderr line on unexpected exit', async () => {
    const dir = makeTempDir()
    const scriptPath = path.join(dir, 'fatal.js')
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
      serverInfo: { name: 'fatal-server', version: '1.0.0' }
    }})
    process.stderr.write('ERROR worker quit with fatal: AuthRequired\\n')
    setTimeout(() => process.exit(1), 100)
  } else if (req.method === 'notifications/initialized') {
    // no reply
  }
})
`,
      'utf8'
    )
    const profile = makeProfile({ stdio: { command: process.execPath, args: [scriptPath], env: [] } })
    const appendDiagnostic = vi.fn()
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000, appendDiagnostic })

    await manager.connect(profile, {})
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(manager.isSessionAlive(profile.id)).toBe(false)

    expect(appendDiagnostic).toHaveBeenCalledWith(
      profile.id,
      expect.objectContaining({ code: 'transport-closed' })
    )
    const closedCall = appendDiagnostic.mock.calls.find(([, entry]) => entry.code === 'transport-closed')
    expect(closedCall?.[1].message).toContain('AuthRequired')
    await manager.shutdown()
  })

  it('does not record a transport-closed diagnostic on deliberate disconnect', async () => {
    const dir = makeTempDir()
    const script = writeServerScript(dir, 'server.js', '{ tools: {} }')
    const profile = makeProfile({ stdio: { command: process.execPath, args: [script], env: [] } })
    const appendDiagnostic = vi.fn()
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000, appendDiagnostic })

    await manager.connect(profile, {})
    await manager.disconnect(profile.id)
    await new Promise((resolve) => setTimeout(resolve, 200))

    const closedCall = appendDiagnostic.mock.calls.find(([, entry]) => entry.code === 'transport-closed')
    expect(closedCall).toBeUndefined()
  })

  it('disconnect closes the session and removes it from the pool', async () => {
    const dir = makeTempDir()
    const script = writeServerScript(dir, 'server.js', '{ tools: {} }')
    const profile = makeProfile({ stdio: { command: process.execPath, args: [script], env: [] } })
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })

    await manager.connect(profile, {})
    expect(manager.isSessionAlive(profile.id)).toBe(true)
    await manager.disconnect(profile.id)
    expect(manager.isSessionAlive(profile.id)).toBe(false)
  })

  it('reclaims idle sessions after the idle timeout', async () => {
    const dir = makeTempDir()
    const script = writeServerScript(dir, 'server.js', '{ tools: {} }')
    const profile = makeProfile({ stdio: { command: process.execPath, args: [script], env: [] } })
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000, idleTimeoutMs: 150 })

    await manager.connect(profile, {})
    expect(manager.isSessionAlive(profile.id)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(manager.isSessionAlive(profile.id)).toBe(false)
  })

  it('connects to a Streamable HTTP server with bearer auth', async () => {
    const server = http.createServer((req, res) => {
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
                serverInfo: { name: 'http-echo', version: '1.0.0' }
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    const httpProfile = makeProfile({
      transport: 'streamable-http',
      stdio: undefined,
      http: { endpoint: `http://127.0.0.1:${port}/mcp` },
      auth: { mode: 'bearer-token', secretPresent: true }
    })
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })

    const session = await manager.connect(httpProfile, async (kind) => (kind === 'access-token' ? 'tok' : null))
    expect(session.info.name).toBe('http-echo')
    expect(session.protocolVersion).toBe('2025-06-18')
    await manager.disconnect(httpProfile.id)
    server.close()
  })

  it('connects to an OAuth Streamable HTTP server using the provider access token', async () => {
    const { endpoint, receivedAuthHeaders } = await startAuthRequiredHttpServer()
    const oauthProfile = makeProfile({
      transport: 'streamable-http',
      stdio: undefined,
      http: { endpoint },
      auth: { mode: 'oauth', secretPresent: true, oauthClientId: 'manual-client' }
    })
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })

    const session = await manager.connect(oauthProfile, async () => null, {
      oauthProvider: makeOauthProvider('oauth-access-token')
    })
    expect(session.info.name).toBe('oauth-http')
    expect(session.protocolVersion).toBe('2025-06-18')
    expect(receivedAuthHeaders).toContain('Bearer oauth-access-token')
    await manager.disconnect(oauthProfile.id)
  })

  it('rejects OAuth Streamable HTTP connections without a provider', async () => {
    const { endpoint } = await startAuthRequiredHttpServer()
    const oauthProfile = makeProfile({
      transport: 'streamable-http',
      stdio: undefined,
      http: { endpoint },
      auth: { mode: 'oauth', secretPresent: false }
    })
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })

    await expect(manager.connect(oauthProfile, async () => null)).rejects.toThrow(/OAuth/i)
  })

  it('connects to a legacy SSE server with bearer auth', async () => {
    let stream: http.ServerResponse | null = null
    const endpoint = await startLegacySseServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: endpoint\ndata: /messages?sessionId=test-session\n\n')
        stream = res
        return
      }
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        const message = JSON.parse(raw) as { method?: string; id?: number }
        res.writeHead(202)
        res.end()
        const sse = stream
        if (!sse || message.method === 'notifications/initialized') return
        if (message.method === 'initialize') {
          sse.write(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'legacy-sse', version: '1.0.0' }
              }
            })}\n\n`
          )
        }
      })
    })
    const sseProfile = makeProfile({
      transport: 'sse',
      stdio: undefined,
      http: { endpoint },
      auth: { mode: 'bearer-token', secretPresent: true }
    })
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })

    const session = await manager.connect(
      sseProfile,
      async (kind) => (kind === 'access-token' ? 'legacy-token' : null)
    )
    expect(session.info.name).toBe('legacy-sse')
    expect(session.protocolVersion).toBe('2024-11-05')
    await manager.disconnect(sseProfile.id)
  })

  it('classifies invalid SSE endpoints as invalid-endpoint', async () => {
    const profile = makeProfile({
      transport: 'sse',
      stdio: undefined,
      http: { endpoint: 'https://192.168.1.10/sse' }
    })
    const result = await testConnection(profile, { connectTimeoutMs: 1000 })
    expect(result).toMatchObject({ ok: false, code: 'invalid-endpoint' })
  })

  it('requires an endpoint and reports SSE transport diagnostics', async () => {
    const missingEndpoint = makeProfile({ transport: 'sse', stdio: undefined, http: undefined })
    const manager = new McpConnectionManager()
    await expect(manager.connect(missingEndpoint, async () => null)).rejects.toThrow(
      'SSE 服务缺少 endpoint 配置'
    )

    const diagnostics: Array<{ code: string; message: string }> = []
    const endpoint = await startLegacySseServer((_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/redirected' })
      res.end()
    })
    const redirectProfile = makeProfile({
      transport: 'sse',
      stdio: undefined,
      http: { endpoint }
    })
    const diagnosticManager = new McpConnectionManager({
      connectTimeoutMs: 2000,
      appendDiagnostic: (serverId, entry) => {
        diagnostics.push(entry)
      }
    })
    await expect(diagnosticManager.connect(redirectProfile, async () => null)).rejects.toThrow(/重定向/)
    await vi.waitFor(() => {
      expect(diagnostics.some((entry) => entry.code === 'sse-diagnostic')).toBe(true)
    })
  })
})
