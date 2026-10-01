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
import { listProfiles, saveToolCache } from './mcpConfigStore'
import { registerMcpIpcHandlers, writeInputToProfile } from './mcpIpc'
import * as mcpOauthService from './mcpOauthService'
import { setSecret } from './mcpSecretStore'
import { clearToolRevocationRequest, isToolRevoked, registerToolRevocationRequest } from '../toolRevocationRegistry'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { createRegisteredMcpTool } from './registeredMcpTool'
import { executeRegisteredTool } from '../tools/toolInvocationCoordinator'
import { createPermitBoundCoordinatorDispatch } from '../tools/permitBoundCoordinatorDispatch'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { McpConnectionManager } from './mcpConnectionManager'
import { rejectPendingConfirmsForToolAcrossLanes, waitForToolConfirm } from '../toolConfirmRegistry'

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

  it('disabling an MCP server revokes its active tool calls across every execution lane', async () => {
    const profileId = 'mcp-global-revocation'
    const toolName = 'lookup_weather'
    const server = makeInput({ id: profileId, name: 'Global revocation', enabled: true, enabledToolNames: [toolName] })
    await handlers['mcp:save-profiles']!(null, { servers: [server] })
    for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
      registerToolRevocationRequest(`${lane}-mcp-active`, lane, `${lane}-mcp-active`)
    }

    try {
      await handlers['mcp:save-profiles']!(null, { servers: [{ ...server, enabled: false }] })
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        expect(isToolRevoked(`${lane}-mcp-active`, toolName)).toBe(true)
      }
    } finally {
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        clearToolRevocationRequest(`${lane}-mcp-active`)
      }
    }
  })

  it('changing an enabled MCP server execution target revokes its active tool calls across every lane', async () => {
    const profileId = 'mcp-target-change-revocation'
    const toolName = 'lookup_target_change'
    const server = makeInput({
      id: profileId, name: 'Target change', enabled: true, transport: 'streamable-http',
      http: { endpoint: 'https://old.example.test/mcp' }, enabledToolNames: [toolName]
    })
    await handlers['mcp:save-profiles']!(null, { servers: [server] })
    for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
      registerToolRevocationRequest(`${lane}-mcp-target-change`, lane, `${lane}-mcp-target-change`)
    }

    try {
      await handlers['mcp:save-profiles']!(null, {
        servers: [{ ...server, http: { endpoint: 'https://new.example.test/mcp' } }]
      })
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        expect(isToolRevoked(`${lane}-mcp-target-change`, toolName)).toBe(true)
      }
    } finally {
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        clearToolRevocationRequest(`${lane}-mcp-target-change`)
      }
    }
  })

  it('clearing credentials revokes active tools on their enabled MCP server across every lane', async () => {
    const profileId = 'mcp-clear-secret-revocation'
    const toolName = 'lookup_auth_change'
    const server = makeInput({
      id: profileId, name: 'Credential change', enabled: true, transport: 'streamable-http',
      auth: { mode: 'bearer-token', accessToken: 'saved-secret' },
      http: { endpoint: 'https://auth.example.test/mcp' }, enabledToolNames: [toolName]
    })
    await handlers['mcp:save-profiles']!(null, { servers: [server] })
    for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
      registerToolRevocationRequest(`${lane}-mcp-clear-secret`, lane, `${lane}-mcp-clear-secret`)
    }

    try {
      await handlers['mcp:clear-secret']!(null, { serverId: profileId, kind: 'access-token' })
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        expect(isToolRevoked(`${lane}-mcp-clear-secret`, toolName)).toBe(true)
      }
    } finally {
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        clearToolRevocationRequest(`${lane}-mcp-clear-secret`)
      }
    }
  })

  it('deleting an MCP server revokes its active tool calls across every execution lane', async () => {
    const profileId = 'mcp-global-delete-revocation'
    const toolName = 'lookup_calendar'
    await handlers['mcp:save-profiles']!(null, {
      servers: [makeInput({ id: profileId, name: 'Delete revocation', enabled: true, enabledToolNames: [toolName] })]
    })
    for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
      registerToolRevocationRequest(`${lane}-mcp-delete-active`, lane, `${lane}-mcp-delete-active`)
    }

    try {
      await handlers['mcp:delete-server']!(null, { serverId: profileId })
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        expect(isToolRevoked(`${lane}-mcp-delete-active`, toolName)).toBe(true)
      }
    } finally {
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        clearToolRevocationRequest(`${lane}-mcp-delete-active`)
      }
    }
  })

  it.each(['desktop', 'feishu', 'wechat', 'automation'] as const)('$lane MCP deletion aborts a claimed registered-tool executor through the production revocation registry', async (lane) => {
    const profileId = 'mcp-claimed-revocation'
    const requestId = `mcp-claimed-delete-${lane}-request`
    const toolUseId = 'mcp-claimed-delete-call'
    const toolName = 'lookup_active'
    await handlers['mcp:save-profiles']!(null, {
      servers: [makeInput({ id: profileId, name: 'Claimed revocation', enabled: true, enabledToolNames: [toolName] })]
    })
    registerToolRevocationRequest(requestId, lane, 'mcp-claimed-delete-turn')
    const revocations = getDefaultAgentRuntime().toolRevocations
    const admission = new InMemoryExecutionAdmissionCoordinator()
    let enteredExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { enteredExecutor = resolve })
    let observedSignal: AbortSignal | undefined
    const executor = vi.fn(async (_input: Record<string, unknown>, context: { signal: AbortSignal }) => {
      observedSignal = context.signal
      enteredExecutor()
      return await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('MCP response unknown after cancellation')), { once: true })
      })
    })
    const registered = createRegisteredMcpTool({ name: toolName, execute: executor } as never)
    const input = { query: 'active request' }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId, turnId: 'mcp-claimed-delete-turn', canonicalInput: input,
      authorizationVersion: 'mcp-rule-v1', targetVersion: 'mcp-target-v1',
      phase: 'recheck', initialFactsHash: 'mcp-facts-v1',
      isAllowed: () => !revocations.isToolRevoked(requestId, toolName),
      recheck: async () => ({ allowed: true, authorizationVersion: 'mcp-rule-v1', targetVersion: 'mcp-target-v1', factsHash: 'mcp-facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'mcp-rule-v1' }) },
      toolRevocations: revocations,
      admission
    })
    const signal = new AbortController().signal
    const execution = executeRegisteredTool(registered, input, {
      requestId, toolUseId, signal, executionContext: { lane } as never
    }, { confirm: async () => true, dispatch })

    try {
      await atExecutor
      expect(observedSignal?.aborted).toBe(false)
      await handlers['mcp:delete-server']!(null, { serverId: profileId })
      expect(isToolRevoked(requestId, toolName)).toBe(true)
      expect(observedSignal?.aborted).toBe(true)
      await expect(execution).rejects.toThrow()
      expect(executor).toHaveBeenCalledOnce()
      expect(admission.activeLeaseCount(requestId)).toBe(0)
    } finally {
      clearToolRevocationRequest(requestId)
    }
  })

  it.each(['desktop', 'feishu', 'wechat', 'automation'] as const)('$lane MCP allowlist update aborts a claimed registered-tool executor', async (lane) => {
    const profileId = 'mcp-claimed-allowlist-revocation'
    const requestId = `mcp-claimed-allowlist-${lane}-request`
    const toolUseId = 'mcp-claimed-allowlist-call'
    const toolName = 'lookup_allowlist_active'
    const server = makeInput({ id: profileId, name: 'Claimed allowlist revocation', enabled: true, enabledToolNames: [toolName] })
    await handlers['mcp:save-profiles']!(null, { servers: [server] })
    registerToolRevocationRequest(requestId, lane, 'mcp-claimed-allowlist-turn')
    const revocations = getDefaultAgentRuntime().toolRevocations
    const admission = new InMemoryExecutionAdmissionCoordinator()
    let enteredExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { enteredExecutor = resolve })
    let observedSignal: AbortSignal | undefined
    const executor = vi.fn(async (_input: Record<string, unknown>, context: { signal: AbortSignal }) => {
      observedSignal = context.signal
      enteredExecutor()
      return await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('MCP response unknown after cancellation')), { once: true })
      })
    })
    const registered = createRegisteredMcpTool({ name: toolName, execute: executor } as never)
    const input = { query: 'active request' }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId, turnId: 'mcp-claimed-allowlist-turn', canonicalInput: input,
      authorizationVersion: 'mcp-rule-v1', targetVersion: 'mcp-target-v1',
      phase: 'recheck', initialFactsHash: 'mcp-facts-v1',
      isAllowed: () => !revocations.isToolRevoked(requestId, toolName),
      recheck: async () => ({ allowed: true, authorizationVersion: 'mcp-rule-v1', targetVersion: 'mcp-target-v1', factsHash: 'mcp-facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'mcp-rule-v1' }) },
      toolRevocations: revocations,
      admission
    })
    const execution = executeRegisteredTool(registered, input, {
      requestId, toolUseId, signal: new AbortController().signal, executionContext: { lane } as never
    }, { confirm: async () => true, dispatch })

    try {
      await atExecutor
      expect(observedSignal?.aborted).toBe(false)
      await handlers['mcp:save-profiles']!(null, { servers: [{ ...server, enabledToolNames: [] }] })
      expect(isToolRevoked(requestId, toolName)).toBe(true)
      expect(observedSignal?.aborted).toBe(true)
      await expect(execution).rejects.toThrow()
      expect(executor).toHaveBeenCalledOnce()
      expect(admission.activeLeaseCount(requestId)).toBe(0)
    } finally {
      clearToolRevocationRequest(requestId)
    }
  })

  it.each(['desktop', 'feishu', 'wechat', 'automation'] as const)('$lane MCP endpoint change aborts a claimed executor while its tool stays enabled', async (lane) => {
    const profileId = 'mcp-claimed-endpoint-change'
    const requestId = `mcp-endpoint-change-${lane}-request`
    const toolUseId = 'mcp-endpoint-change-call'
    const toolName = 'lookup_endpoint_active'
    const server = makeInput({
      id: profileId, name: 'Claimed endpoint change', enabled: true, transport: 'streamable-http',
      http: { endpoint: 'https://old.example.test/mcp' }, enabledToolNames: [toolName]
    })
    await handlers['mcp:save-profiles']!(null, { servers: [server] })
    registerToolRevocationRequest(requestId, lane, 'mcp-endpoint-change-turn')
    const revocations = getDefaultAgentRuntime().toolRevocations
    const admission = new InMemoryExecutionAdmissionCoordinator()
    let enteredExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { enteredExecutor = resolve })
    let observedSignal: AbortSignal | undefined
    const executor = vi.fn(async (_input: Record<string, unknown>, context: { signal: AbortSignal }) => {
      observedSignal = context.signal
      enteredExecutor()
      return await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('MCP response unknown after endpoint change')), { once: true })
      })
    })
    const registered = createRegisteredMcpTool({ name: toolName, execute: executor } as never)
    const input = { query: 'in flight' }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId, turnId: 'mcp-endpoint-change-turn', canonicalInput: input,
      authorizationVersion: 'mcp-rule-v1', targetVersion: 'mcp-target-v1',
      phase: 'recheck', initialFactsHash: 'mcp-facts-v1',
      isAllowed: () => !revocations.isToolRevoked(requestId, toolName),
      recheck: async () => ({ allowed: true, authorizationVersion: 'mcp-rule-v1', targetVersion: 'mcp-target-v1', factsHash: 'mcp-facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'mcp-rule-v1' }) },
      toolRevocations: revocations,
      admission
    })
    const execution = executeRegisteredTool(registered, input, {
      requestId, toolUseId, signal: new AbortController().signal, executionContext: { lane } as never
    }, { confirm: async () => true, dispatch })

    try {
      await atExecutor
      expect(observedSignal?.aborted).toBe(false)
      await handlers['mcp:save-profiles']!(null, { servers: [{ ...server, http: { endpoint: 'https://new.example.test/mcp' } }] })
      expect(isToolRevoked(requestId, toolName)).toBe(true)
      expect(observedSignal?.aborted).toBe(true)
      await expect(execution).rejects.toThrow()
      expect(executor).toHaveBeenCalledOnce()
      expect(admission.activeLeaseCount(requestId)).toBe(0)
      expect((await handlers['mcp:list']!(null) as { servers: Array<{ enabledToolNames: string[] }> }).servers[0]?.enabledToolNames).toContain(toolName)
    } finally {
      clearToolRevocationRequest(requestId)
    }
  })

  it('endpoint change rejects a pending confirmation for the cached mapped MCP capability', async () => {
    const profileId = 'mcp-pending-confirm-endpoint-change'
    const requestId = 'mcp-pending-confirm-endpoint-change-request'
    const toolName = 'mcp_docs_search'
    const server = makeInput({
      id: profileId, name: 'Pending confirmation', enabled: true, transport: 'streamable-http',
      http: { endpoint: 'https://old.example.test/mcp' }, enabledToolNames: ['search']
    })
    await handlers['mcp:save-profiles']!(null, { servers: [server] })
    saveToolCache(db, profileId, {
      protocolVersion: '2025-06-18', discoveredAt: '2026-01-01T00:00:00.000Z',
      tools: [{
        serverId: profileId, originalName: 'search', mappedName: toolName, description: 'Search docs',
        inputSchema: { type: 'object' }, annotations: { destructiveHint: true }, discoveredAt: '2026-01-01T00:00:00.000Z'
      }]
    })
    registerToolRevocationRequest(requestId, 'desktop', requestId)
    const pendingConfirmation = waitForToolConfirm(requestId, 'mapped-confirmation-call', undefined, {
      toolName, lane: 'desktop'
    })

    try {
      await handlers['mcp:save-profiles']!(null, {
        servers: [{ ...server, http: { endpoint: 'https://new.example.test/mcp' } }]
      })
      await expect(pendingConfirmation).resolves.toBe('cancelled')
      expect(isToolRevoked(requestId, toolName)).toBe(true)
      expect((await handlers['mcp:list']!(null) as { servers: Array<{ enabledToolNames: string[] }> }).servers[0]?.enabledToolNames).toContain('search')
    } finally {
      clearToolRevocationRequest(requestId)
    }
  })

  it('refresh-tools preserves mapped identity and revokes pending confirmation when discovered authority changes', async () => {
    const profileId = 'mcp-refresh-pending-confirm'
    const requestId = 'mcp-refresh-pending-confirm-request'
    const toolName = 'mcp_docs_search'
    const server = makeInput({
      id: profileId, name: 'Docs', enabled: true, transport: 'streamable-http',
      http: { endpoint: 'https://docs.example.test/mcp' }, enabledToolNames: ['search']
    })
    await handlers['mcp:save-profiles']!(null, { servers: [server] })
    saveToolCache(db, profileId, {
      protocolVersion: '2025-06-18', discoveredAt: '2026-01-01T00:00:00.000Z',
      tools: [{
        serverId: profileId, originalName: 'search', mappedName: toolName, description: 'Search docs',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: true }, discoveredAt: '2026-01-01T00:00:00.000Z'
      }]
    })
    const connect = vi.spyOn(McpConnectionManager.prototype, 'connect').mockResolvedValue({
      serverId: profileId,
      client: { listTools: async () => ({ tools: [{
        name: 'search', description: 'Search docs',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: false, destructiveHint: true }
      }] }) },
      info: { name: 'Docs' }, protocolVersion: '2025-06-18', capabilities: {}, close: async () => undefined
    } as never)
    registerToolRevocationRequest(requestId, 'desktop', requestId)
    const pendingConfirmation = waitForToolConfirm(requestId, 'refresh-confirmation-call', undefined, {
      toolName, lane: 'desktop'
    })

    try {
      const result = await handlers['mcp:refresh-tools']!(null, { serverId: profileId }) as {
        ok: boolean; tools?: Array<{ mappedName: string }>
      }
      expect(result.ok).toBe(true)
      expect(result.tools?.map((tool) => tool.mappedName)).toEqual([toolName])
      expect(isToolRevoked(requestId, toolName)).toBe(true)
      await expect(pendingConfirmation).resolves.toBe('cancelled')
    } finally {
      rejectPendingConfirmsForToolAcrossLanes(toolName)
      await pendingConfirmation
      clearToolRevocationRequest(requestId)
      connect.mockRestore()
    }
  })

  it('background OAuth token refresh through mcp:refresh-tools aborts an active claimed MCP executor', async () => {
    const profileId = 'mcp-background-oauth-refresh'
    const requestId = 'mcp-background-oauth-active-request'
    const toolName = 'lookup_oauth_refresh'
    await handlers['mcp:save-profiles']!(null, {
      servers: [makeInput({
        id: profileId, name: 'Background OAuth refresh', enabled: true, transport: 'streamable-http',
        http: { endpoint: 'https://mcp.example.test' }, auth: { mode: 'oauth', oauthClientId: 'oauth-client' },
        enabledToolNames: [toolName]
      })]
    })
    await setSecret(db, profileId, 'access-token', 'old-access')
    await setSecret(db, profileId, 'refresh-token', 'old-refresh')
    registerToolRevocationRequest(requestId, 'desktop', 'mcp-oauth-refresh-turn')
    const runtime = getDefaultAgentRuntime()
    const admission = new InMemoryExecutionAdmissionCoordinator()
    let enteredExecutor!: () => void
    const atExecutor = new Promise<void>((resolve) => { enteredExecutor = resolve })
    let observedSignal: AbortSignal | undefined
    const executor = vi.fn(async (_input: Record<string, unknown>, context: { signal: AbortSignal }) => {
      observedSignal = context.signal
      enteredExecutor()
      return await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('MCP result uncertain after OAuth refresh')), { once: true })
      })
    })
    const registered = createRegisteredMcpTool({ name: toolName, execute: executor } as never)
    const input = { query: 'active during refresh' }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId, turnId: 'mcp-oauth-refresh-turn', canonicalInput: input,
      authorizationVersion: 'mcp-rule-v1', targetVersion: 'mcp-target-v1', phase: 'recheck', initialFactsHash: 'mcp-facts-v1',
      isAllowed: () => !runtime.toolRevocations.isToolRevoked(requestId, toolName),
      recheck: async () => ({ allowed: true, authorizationVersion: 'mcp-rule-v1', targetVersion: 'mcp-target-v1', factsHash: 'mcp-facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'mcp-rule-v1' }) },
      toolRevocations: runtime.toolRevocations, admission
    })
    const execution = executeRegisteredTool(registered, input, {
      requestId, toolUseId: 'mcp-oauth-refresh-call', signal: new AbortController().signal,
      executionContext: { lane: 'desktop' } as never
    }, { confirm: async () => true, dispatch })
    const connect = vi.spyOn(McpConnectionManager.prototype, 'connect').mockImplementation(async (_profile, _secrets, options) => {
      await options?.oauthProvider?.saveTokens({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer' })
      return {
        serverId: profileId, client: { listTools: async () => ({ tools: [{ name: 'remote-tool', inputSchema: { type: 'object' } }] }) },
        info: { name: 'OAuth MCP' }, protocolVersion: '2025-06-18', capabilities: {}, close: async () => undefined
      } as never
    })

    try {
      await atExecutor
      expect(observedSignal?.aborted).toBe(false)
      const refresh = await handlers['mcp:refresh-tools']!(null, { serverId: profileId })
      expect(refresh).toMatchObject({ ok: true })
      expect(connect).toHaveBeenCalledOnce()
      expect(await mcpOauthService.createMcpOAuthClientProvider(db, listProfiles(db)[0]!).tokens()).toMatchObject({
        access_token: 'new-access', refresh_token: 'new-refresh'
      })
      expect(runtime.toolRevocations.isToolRevoked(requestId, toolName)).toBe(true)
      expect(observedSignal?.aborted).toBe(true)
      await expect(execution).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
      expect(admission.activeLeaseCount(requestId)).toBe(0)
    } finally {
      clearToolRevocationRequest(requestId)
      connect.mockRestore()
    }
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

  it('successful MCP OAuth reauthorization revokes active calls across every execution lane', async () => {
    const profileId = 'mcp-oauth-reauth-revocation'
    const toolName = 'lookup_oauth_reauth'
    await handlers['mcp:save-profiles']!(null, {
      servers: [makeInput({
        id: profileId, name: 'OAuth reauthorization', enabled: true, transport: 'streamable-http',
        http: { endpoint: 'https://oauth.example.test/mcp' }, auth: { mode: 'oauth', oauthClientId: 'client' },
        enabledToolNames: [toolName]
      })]
    })
    const startOAuth = vi.spyOn(mcpOauthService, 'startOAuthFlow').mockResolvedValue({ ok: true } as never)
    for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
      registerToolRevocationRequest(`${lane}-mcp-oauth-reauth`, lane, `${lane}-mcp-oauth-reauth`)
    }

    try {
      await handlers['mcp:oauth-start']!(null, { serverId: profileId })
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        expect(isToolRevoked(`${lane}-mcp-oauth-reauth`, toolName)).toBe(true)
      }
    } finally {
      startOAuth.mockRestore()
      for (const lane of ['desktop', 'feishu', 'wechat', 'automation'] as const) {
        clearToolRevocationRequest(`${lane}-mcp-oauth-reauth`)
      }
    }
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

  describe('mcp:refresh-tools 私网拒绝透传（评审 B3 回归）', () => {
    it('字面私网 IP endpoint：结果与 lastError.code 均为精确码 private-address', async () => {
      await handlers['mcp:save-profiles']!(null, {
        servers: [
          makeInput({
            id: 'private-blocked',
            name: 'PrivateBlocked',
            enabled: true,
            transport: 'streamable-http',
            stdio: undefined,
            http: { endpoint: 'https://10.154.200.32/mcp' }
          })
        ]
      })

      const result = (await handlers['mcp:refresh-tools']!(null, { serverId: 'private-blocked' })) as {
        ok: boolean
        code?: string
        message?: string
      }
      expect(result.ok).toBe(false)
      expect(result.code).toBe('private-address')
      expect(result.message).toContain('允许连接内网')

      const profile = listProfiles(db).find((p) => p.id === 'private-blocked')
      expect(profile?.status).toBe('failed')
      expect(profile?.lastError?.code).toBe('private-address')
    })
  })
})

describe('writeInputToProfile 转换点（评审 B1）', () => {
  it('carries allowPrivateNetwork into the http profile and preserves off semantics', () => {
    const on = writeInputToProfile(
      makeInput({
        transport: 'streamable-http',
        stdio: undefined,
        http: { endpoint: 'https://intranet.example.com/mcp', allowPrivateNetwork: true }
      })
    )
    expect(on.http).toEqual({ endpoint: 'https://intranet.example.com/mcp', allowPrivateNetwork: true })

    const off = writeInputToProfile(
      makeInput({
        transport: 'streamable-http',
        stdio: undefined,
        http: { endpoint: 'https://example.com/mcp' }
      })
    )
    expect(off.http).toEqual({ endpoint: 'https://example.com/mcp' })
  })
})
