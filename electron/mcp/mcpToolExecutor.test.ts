import fs from 'fs'
import fsPromises from 'node:fs/promises'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerProfile } from '../../src/shared/mcpTypes'
import type { ToolExecutionContext } from '../tools/types'
import { McpConnectionManager } from './mcpConnectionManager'
import { createMcpToolExecutor, McpConcurrencyGate, shouldPersistMcpArtifact } from './mcpToolExecutor'

const tempDirs: string[] = []
afterEach(() => vi.restoreAllMocks())
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

  it.each([
    ['disabled server', (profile: McpServerProfile) => ({ ...profile, enabled: false })],
    ['disabled tool', (profile: McpServerProfile) => ({ ...profile, enabledToolNames: [] })]
  ])('does not dispatch when %s after approval', async (_label, mutateProfile) => {
    const profile = mutateProfile(makeProfile('server-revoked', 'unused'))
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'should not run' }] }))
    const executor = createMcpToolExecutor({
      serverId: 'server-revoked', serverName: 'Echo', originalName: 'echo', mappedName: 'mcp_echo_echo_12345678', description: '', inputSchema: { type: 'object' }
    }, {
      getSession: async () => ({ client: { callTool } }) as never,
      getProfile: () => profile,
      invalidateSession: async () => undefined
    })
    await expect(executor.execute({ text: 'x' }, makeContext())).resolves.toMatchObject({ success: false })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('does not dispatch when cached schema differs from the approved request snapshot', async () => {
    const profile = makeProfile('server-schema', 'unused')
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'should not run' }] }))
    const executor = createMcpToolExecutor({
      serverId: 'server-schema', serverName: 'Echo', originalName: 'echo', mappedName: 'mcp_echo_echo_12345678', description: '', inputSchema: { type: 'object' }
    }, {
      getSession: async () => ({ client: { callTool } }) as never,
      getProfile: () => profile,
      getCurrentTool: () => ({ inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }),
      invalidateSession: async () => undefined
    })
    await expect(executor.execute({ text: 'x' }, makeContext())).resolves.toMatchObject({ success: false, error: expect.stringContaining('schema 已变更') })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('rechecks enablement after waiting for the shared concurrency gate', async () => {
    const profile = makeProfile('server-queued-revoke', 'unused')
    const gate = new McpConcurrencyGate(1, 1)
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })
    const first = createMcpToolExecutor({ serverId: profile.id, serverName: profile.name, originalName: 'echo', mappedName: 'mcp_echo_1', description: '', inputSchema: {} }, {
      getSession: async () => ({ client: { callTool: async () => { firstStarted(); await new Promise<void>((resolve) => { releaseFirst = resolve }); return { content: [] } } } }) as never,
      getProfile: () => profile, invalidateSession: async () => undefined
    }, gate)
    const secondCallTool = vi.fn(async () => ({ content: [] }))
    const getSecondSession = vi.fn(async () => ({ client: { callTool: secondCallTool } }) as never)
    const second = createMcpToolExecutor({ serverId: profile.id, serverName: profile.name, originalName: 'echo', mappedName: 'mcp_echo_2', description: '', inputSchema: {} }, {
      getSession: getSecondSession,
      getProfile: () => profile,
      invalidateSession: async () => undefined
    }, gate)
    const firstPending = first.execute({}, makeContext())
    await firstStartedPromise
    const secondPending = second.execute({}, makeContext())
    profile.enabled = false
    releaseFirst()
    await firstPending
    await expect(secondPending).resolves.toMatchObject({ success: false })
    expect(getSecondSession).not.toHaveBeenCalled()
    expect(secondCallTool).not.toHaveBeenCalled()
  })

  it('rechecks revocation after asynchronous connection completes and before callTool', async () => {
    const profile = makeProfile('server-connect-revoke', 'unused')
    const callTool = vi.fn(async () => ({ content: [] }))
    let finishConnect!: () => void
    const connecting = new Promise<void>((resolve) => { finishConnect = resolve })
    const executor = createMcpToolExecutor({ serverId: profile.id, serverName: profile.name, originalName: 'echo', mappedName: 'mcp_echo_revoke', description: '', inputSchema: {} }, {
      getSession: async () => {
        await connecting
        profile.enabled = false
        return { client: { callTool } } as never
      },
      getProfile: () => profile,
      invalidateSession: async () => undefined
    })
    const pending = executor.execute({}, makeContext())
    await Promise.resolve()
    finishConnect()
    await expect(pending).resolves.toMatchObject({ success: false })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('rechecks schema and connection fingerprint after asynchronous connection completes', async () => {
    const profile = makeProfile('server-connect-version', 'unused')
    const callTool = vi.fn(async () => ({ content: [] }))
    let finishConnect!: () => void
    const connecting = new Promise<void>((resolve) => { finishConnect = resolve })
    let fingerprint = 'approved'
    let schema: Record<string, unknown> = { type: 'object' }
    const executor = createMcpToolExecutor({ serverId: profile.id, serverName: profile.name, originalName: 'echo', mappedName: 'mcp_echo_version', description: '', inputSchema: { type: 'object' } }, {
      getSession: async () => { await connecting; fingerprint = 'changed'; schema = { type: 'object', properties: { text: { type: 'string' } } }; return { client: { callTool } } as never },
      getProfile: () => profile,
      expectedProfileFingerprint: 'approved',
      getCurrentProfileFingerprint: () => fingerprint,
      getCurrentTool: () => ({ inputSchema: schema }),
      invalidateSession: async () => undefined
    })
    const pending = executor.execute({}, makeContext())
    await Promise.resolve()
    finishConnect()
    await expect(pending).resolves.toMatchObject({ success: false })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after asynchronous connection completes and before callTool', async () => {
    const profile = makeProfile('server-connect-cancel', 'unused')
    const callTool = vi.fn(async () => ({ content: [] }))
    let finishConnect!: () => void
    const connecting = new Promise<void>((resolve) => { finishConnect = resolve })
    const controller = new AbortController()
    const executor = createMcpToolExecutor({ serverId: profile.id, serverName: profile.name, originalName: 'echo', mappedName: 'mcp_echo_cancel', description: '', inputSchema: {} }, {
      getSession: async () => { await connecting; return { client: { callTool } } as never },
      getProfile: () => profile,
      invalidateSession: async () => undefined
    })
    const pending = executor.execute({}, makeContext({ signal: controller.signal }))
    await Promise.resolve()
    controller.abort()
    finishConnect()
    await expect(pending).resolves.toMatchObject({ success: false })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('returns a readable full-text artifact when directory sync is unsupported', async () => {
    const userDataDir = makeTempDir()
    const directory = path.join(userDataDir, 'shell-output', 'mcp')
    const originalOpen = fsPromises.open.bind(fsPromises)
    vi.spyOn(fsPromises, 'open').mockImplementation((async (filePath: fs.PathLike, ...args: unknown[]) => {
      if (filePath === directory) throw Object.assign(new Error('directory sync unsupported'), { code: 'EISDIR' })
      return (originalOpen as (...input: unknown[]) => Promise<Awaited<ReturnType<typeof fsPromises.open>>>)(filePath, ...args)
    }) as typeof fsPromises.open)
    const fullText = `FULL-ATTACHMENT-BEGIN\n${'MCP attachment body '.repeat(40_000)}\nFULL-ATTACHMENT-END`
    const session = {
      serverId: 'server-1',
      client: { callTool: async () => ({ content: [{ type: 'text', text: fullText }] }) },
      info: { name: 'Echo' }, protocolVersion: '', capabilities: {}, close: async () => undefined
    }
    const executor = createMcpToolExecutor({
      serverId: 'server-1', serverName: 'Echo', originalName: 'echo', mappedName: 'mcp_echo_echo_12345678', description: '', inputSchema: { type: 'object' }
    }, {
      getSession: async () => session as never,
      getProfile: () => makeProfile('server-1', 'unused'),
      invalidateSession: async () => undefined
    })
    const result = await executor.execute({ text: 'large' }, makeContext({ userDataDir }))
    vi.restoreAllMocks()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.displayData.artifactId).toMatch(/^artifact-mcp-/)
      const artifact = fs.readFileSync(path.join(directory, `${result.displayData.artifactId}.log`), 'utf8')
      expect(artifact).toContain('FULL-ATTACHMENT-BEGIN')
      expect(artifact).toContain('FULL-ATTACHMENT-END')
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
      serverId: 'server-uncertain', serverName: 'Docs', originalName: 'echo', mappedName: 'mcp_docs_publish', description: '', inputSchema: { type: 'object' }
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
