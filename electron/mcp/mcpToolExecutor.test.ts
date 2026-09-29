import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { McpServerProfile } from '../../src/shared/mcpTypes'
import type { ToolExecutionContext } from '../tools/types'
import { McpConnectionManager } from './mcpConnectionManager'
import { createMcpToolExecutor, shouldPersistMcpArtifact } from './mcpToolExecutor'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mcp-exec-'))
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

function writeEchoServer(dir: string, behavior: string): string {
  const scriptPath = path.join(dir, 'server.js')
  fs.writeFileSync(
    scriptPath,
    `
const fs = require('fs')
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
const log = (line) => fs.appendFileSync(${JSON.stringify(path.join(dir, 'events.log'))}, line + '\\n')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  log(req.method)
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'echo-server', version: '1.0.0' }
    }})
  } else if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') {
    // no reply
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [
      { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
    ]}})
  } else if (req.method === 'tools/call') {
    ${behavior}
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
  }
})
`,
    'utf8'
  )
  return scriptPath
}

const ECHO_OK = `
    send({ jsonrpc: '2.0', id: req.id, result: {
      content: [{ type: 'text', text: req.params.arguments.text }],
      structuredContent: { echoed: req.params.arguments.text }
    }})`

const ECHO_ERROR = `
    send({ jsonrpc: '2.0', id: req.id, result: {
      content: [{ type: 'text', text: 'business failure' }],
      isError: true
    }})`

const ECHO_SLOW = `
    setTimeout(() => {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'late' }] } })
    }, 3000)`

function makeProfile(serverId: string, scriptPath: string): McpServerProfile {
  return {
    id: serverId,
    name: 'Echo',
    enabled: true,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none', secretPresent: false },
    stdio: { command: process.execPath, args: [scriptPath], env: [] },
    enabledToolNames: ['echo'],
    status: 'connected',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workDir: process.cwd(),
    userDataDir: os.tmpdir(),
    requestId: 'req-1',
    toolUseId: 'tool-use-1',
    sessionId: 'session-1',
    sendProgress: () => undefined,
    signal: new AbortController().signal,
    fileStateCache: undefined as never,
    toolsConfig: { enabled: true, deniedTools: [], allowedTools: [] },
    ...overrides
  }
}

describe('mcpToolExecutor', () => {
  it('uses a byte-safe 512 KiB artifact threshold', () => {
    expect(shouldPersistMcpArtifact('a'.repeat(512 * 1024))).toBe(false)
    expect(shouldPersistMcpArtifact('a'.repeat(512 * 1024 + 1))).toBe(true)
    expect(shouldPersistMcpArtifact('中'.repeat(256 * 1024 + 1))).toBe(false)
  })
  it('calls the server tool and returns structured content', async () => {
    const dir = makeTempDir()
    const script = writeEchoServer(dir, ECHO_OK)
    const profile = makeProfile('server-1', script)
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })
    const executor = createMcpToolExecutor(
      {
        serverId: 'server-1',
        serverName: 'Echo',
        originalName: 'echo',
        mappedName: 'mcp_echo_echo_12345678',
        description: '',
        inputSchema: { type: 'object' }
      },
      {
        getSession: (id) => manager.connect(profile, async () => null),
        getProfile: () => profile,
        invalidateSession: (id) => manager.disconnect(id)
      }
    )

    const result = await executor.execute({ text: 'hi' }, makeContext())
    await manager.shutdown()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ echoed: 'hi' })
    }
  })

  it('returns a safe error when the server reports isError', async () => {
    const dir = makeTempDir()
    const script = writeEchoServer(dir, ECHO_ERROR)
    const profile = makeProfile('server-1', script)
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })
    const executor = createMcpToolExecutor(
      {
        serverId: 'server-1',
        serverName: 'Echo',
        originalName: 'echo',
        mappedName: 'mcp_echo_echo_12345678',
        description: '',
        inputSchema: { type: 'object' }
      },
      {
        getSession: (id) => manager.connect(profile, async () => null),
        getProfile: () => profile,
        invalidateSession: (id) => manager.disconnect(id)
      }
    )

    const result = await executor.execute({ text: 'x' }, makeContext())
    await manager.shutdown()
    expect(result.success).toBe(false)
    expect(result.error).toContain('business failure')
  })

  it('rejects invalid call arguments without touching the server', async () => {
    const executor = createMcpToolExecutor(
      {
        serverId: 'server-1',
        serverName: 'Echo',
        originalName: 'echo',
        mappedName: 'mcp_echo_echo_12345678',
        description: '',
        inputSchema: { type: 'object' }
      },
      {
        getSession: async () => {
          throw new Error('should not connect')
        },
        getProfile: () => makeProfile('server-1', 'unused'),
        invalidateSession: async () => undefined
      }
    )
    const result = await executor.execute('not-an-object', makeContext())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/参数/)
  })

  it('cancels the call on abort and rejects with uncertain outcome after MCP accepted the request', async () => {
    const dir = makeTempDir()
    const script = writeEchoServer(dir, ECHO_SLOW)
    const profile = makeProfile('server-1', script)
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })
    const executor = createMcpToolExecutor(
      {
        serverId: 'server-1',
        serverName: 'Echo',
        originalName: 'echo',
        mappedName: 'mcp_echo_echo_12345678',
        description: '',
        inputSchema: { type: 'object' }
      },
      {
        getSession: (id) => manager.connect(profile, async () => null),
        getProfile: () => profile,
        invalidateSession: (id) => manager.disconnect(id)
      }
    )

    const controller = new AbortController()
    const resultPromise = executor.execute({ text: 'x' }, makeContext({ signal: controller.signal }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    controller.abort()
    await expect(resultPromise).rejects.toMatchObject({ name: 'McpToolExecutionUncertainError' })
    await manager.shutdown()
    // Server 应收到 notifications/cancelled
    const events = fs.readFileSync(path.join(dir, 'events.log'), 'utf8')
    expect(events).toContain('notifications/cancelled')
  })

  it('rejects with uncertain outcome when an in-flight MCP call is aborted', async () => {
    const controller = new AbortController()
    let enteredCall!: () => void
    const atCall = new Promise<void>((resolve) => { enteredCall = resolve })
    const callTool = async (_request: unknown, _schema: unknown, options: { signal: AbortSignal }) => {
      enteredCall()
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('MCP request cancelled'), { name: 'AbortError' })), { once: true })
      })
    }
    const executor = createMcpToolExecutor({
      serverId: 'server-uncertain', serverName: 'Docs', originalName: 'publish', mappedName: 'mcp_docs_publish', description: '', inputSchema: { type: 'object' }
    }, {
      getSession: async () => ({ client: { callTool } }) as never,
      getProfile: () => makeProfile('server-uncertain', 'unused'),
      invalidateSession: async () => undefined
    })
    const pending = executor.execute({ text: 'publish' }, makeContext({ signal: controller.signal }))
    await atCall
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'McpToolExecutionUncertainError' })
  })

  it('times out the call with uncertain outcome when the server is slow', async () => {
    const dir = makeTempDir()
    const script = writeEchoServer(dir, ECHO_SLOW)
    const profile = { ...makeProfile('server-1', script), timeoutSec: 1 }
    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })
    const executor = createMcpToolExecutor(
      {
        serverId: 'server-1',
        serverName: 'Echo',
        originalName: 'echo',
        mappedName: 'mcp_echo_echo_12345678',
        description: '',
        inputSchema: { type: 'object' }
      },
      {
        getSession: (id) => manager.connect(profile, async () => null),
        getProfile: () => profile,
        invalidateSession: (id) => manager.disconnect(id)
      }
    )

    const started = Date.now()
    const result = executor.execute({ text: 'x' }, makeContext())
    await expect(result).rejects.toMatchObject({ name: 'McpToolExecutionUncertainError' })
    const elapsed = Date.now() - started
    await manager.shutdown()

    expect(elapsed).toBeLessThan(3000)
  })

  it('keeps sanitized timeout diagnostics on an uncertain in-flight request', async () => {
    const failingSession = {
      serverId: 'server-1',
      client: {
        callTool: async () => {
          throw new Error('Request timed out after 60000ms')
        }
      },
      info: { name: 'Echo' },
      protocolVersion: '',
      capabilities: {},
      close: async () => undefined
    }
    const executor = createMcpToolExecutor(
      {
        serverId: 'server-1',
        serverName: 'Echo',
        originalName: 'echo',
        mappedName: 'mcp_echo_echo_12345678',
        description: '',
        inputSchema: { type: 'object' }
      },
      {
        getSession: async () => failingSession as never,
        getProfile: () => makeProfile('server-1', 'unused'),
        invalidateSession: async () => undefined,
        getRecentDiagnostics: () => [
          {
            id: 'd1',
            code: 'stdio-stderr',
            message:
              '\x1b[2m2026-08-28T16:26:48Z\x1b[0m \x1b[31mERROR\x1b[0m worker quit with fatal: Transport channel closed, AuthRequired',
            occurredAt: new Date().toISOString()
          }
        ]
      }
    )

    const result = executor.execute({ text: 'x' }, makeContext())
    await expect(result).rejects.toMatchObject({
      name: 'McpToolExecutionUncertainError',
      safeMessage: expect.stringContaining('Request timed out after 60000ms')
    })
    await expect(result).rejects.toMatchObject({ safeMessage: expect.stringContaining('[stdio-stderr]') })
    await expect(result).rejects.toMatchObject({ safeMessage: expect.stringContaining('AuthRequired') })
    // ANSI 转义序列应被剥离
    await expect(result).rejects.not.toMatchObject({ safeMessage: expect.stringContaining('\x1b') })
  })

  it('classifies AuthRequired as an auth failure and invalidates the session', async () => {
    let invalidated = 0
    const failingSession = {
      serverId: 'server-1',
      client: {
        callTool: async () => {
          throw new Error(
            'Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer ..." })'
          )
        }
      },
      info: { name: 'Echo' },
      protocolVersion: '',
      capabilities: {},
      close: async () => undefined
    }
    const executor = createMcpToolExecutor(
      {
        serverId: 'server-1',
        serverName: 'Echo',
        originalName: 'echo',
        mappedName: 'mcp_echo_echo_12345678',
        description: '',
        inputSchema: { type: 'object' }
      },
      {
        getSession: async () => failingSession as never,
        getProfile: () => makeProfile('server-1', 'unused'),
        invalidateSession: async () => {
          invalidated += 1
        }
      }
    )

    const result = executor.execute({ text: 'x' }, makeContext())
    await expect(result).rejects.toMatchObject({ name: 'McpToolExecutionUncertainError', safeMessage: expect.stringContaining('AuthRequired') })
    expect(invalidated).toBe(1)
  })

  it('classifies "Transport channel closed" as a connection failure', async () => {
    let invalidated = 0
    const failingSession = {
      serverId: 'server-1',
      client: {
        callTool: async () => {
          throw new Error('Transport channel closed')
        }
      },
      info: { name: 'Echo' },
      protocolVersion: '',
      capabilities: {},
      close: async () => undefined
    }
    const executor = createMcpToolExecutor(
      {
        serverId: 'server-1',
        serverName: 'Echo',
        originalName: 'echo',
        mappedName: 'mcp_echo_echo_12345678',
        description: '',
        inputSchema: { type: 'object' }
      },
      {
        getSession: async () => failingSession as never,
        getProfile: () => makeProfile('server-1', 'unused'),
        invalidateSession: async () => {
          invalidated += 1
        }
      }
    )

    const result = executor.execute({ text: 'x' }, makeContext())
    await expect(result).rejects.toMatchObject({ name: 'McpToolExecutionUncertainError', safeMessage: expect.stringContaining('Transport channel closed') })
    expect(invalidated).toBe(1)
  })
})
