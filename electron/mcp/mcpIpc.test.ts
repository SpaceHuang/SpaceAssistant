import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import type { AppDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import type { McpServerWriteInput } from '../../src/shared/mcpTypes'
import { appendDiagnostic } from './mcpDiagnostics'
import { registerMcpIpcHandlers } from './mcpIpc'

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
    toolConfirmPolicy: 'always',
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
})
