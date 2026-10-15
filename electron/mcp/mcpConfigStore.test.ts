import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database'
import { getConfigValue } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import type { McpServerWriteInput } from '../../src/shared/mcpTypes'
import { MCP_MAX_SERVERS } from '../../src/shared/mcpTypes'
import { MCP_SECRETS_CONFIG_KEY, getSecret } from './mcpSecretStore'
import {
  clearToolCache,
  clearMcpAccountAuthorizations,
  deleteServer,
  getToolCache,
  appendServer,
  listProfiles,
  refreshProfilesSecretFlags,
  saveProfiles,
  saveToolCache,
  updateServerStatus
} from './mcpConfigStore'
import { appendDiagnostic, clearDiagnostics, getDiagnostics } from './mcpDiagnostics'
import * as secureApiKey from '../secureApiKey'

function makeWriteInput(overrides: Partial<McpServerWriteInput> = {}): McpServerWriteInput {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'GitHub',
    enabled: false,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none' },
    stdio: {
      command: 'node',
      args: ['server.js'],
      env: []
    },
    enabledToolNames: [],
    ...overrides
  }
}

describe('mcpConfigStore', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    vi.spyOn(secureApiKey, 'encryptSecret').mockImplementation((plain) => `aes:${plain}`)
    vi.spyOn(secureApiKey, 'decryptSecret').mockImplementation((value) => value.startsWith('aes:') ? value.slice(4) : value.replace(/^enc:/, ''))
    vi.spyOn(secureApiKey, 'isSecretEncrypted').mockImplementation((value) => value.startsWith('aes:'))
    vi.spyOn(secureApiKey, 'isLegacySecret').mockImplementation((value) => !value.startsWith('aes:'))
    const temp = createTempDatabase('sa-mcp-config-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('listProfiles returns an empty list when nothing is stored', () => {
    expect(listProfiles(db)).toEqual([])
  })

  it('persists descriptor-bound public-read trust, preserves it on append, and clears it when the endpoint changes', async () => {
    const input = makeWriteInput({
      enabled: true,
      transport: 'streamable-http',
      stdio: undefined,
      http: { endpoint: 'https://public.example.com/mcp' },
      enabledToolNames: ['search'],
      publicReadOnlyTools: { search: 'a'.repeat(64) }
    })
    await saveProfiles(db, [input], { allowPublicReadTrustChanges: true })
    expect(listProfiles(db)[0]?.publicReadOnlyTools).toEqual({ search: 'a'.repeat(64) })

    await appendServer(db, makeWriteInput({ id: 'server-b', name: 'Other' }))
    expect(listProfiles(db).find(({ id }) => id === input.id)?.publicReadOnlyTools).toEqual({ search: 'a'.repeat(64) })

    await saveProfiles(db, [{ ...input, publicReadOnlyTools: { search: 'b'.repeat(64) } }])
    expect(listProfiles(db)[0]?.publicReadOnlyTools).toEqual({ search: 'a'.repeat(64) })

    await saveProfiles(db, [{ ...input, http: { endpoint: 'https://changed.example.com/mcp' } }], { allowPublicReadTrustChanges: true })
    expect(listProfiles(db)[0]?.publicReadOnlyTools).toBeUndefined()
  })

  it('persists account-use authorization only through its explicit settings path and clears it on connection changes', async () => {
    const input = makeWriteInput({ enabled: true, transport: 'streamable-http', stdio: undefined,
      http: { endpoint: 'https://account.example.test/mcp' }, enabledToolNames: ['search'],
      accountAuthorizedTools: { search: 'a'.repeat(64) } })
    await saveProfiles(db, [input])
    expect(listProfiles(db)[0]?.accountAuthorizedTools).toBeUndefined()

    await saveProfiles(db, [input], { allowAccountAuthorizationChanges: true })
    expect(listProfiles(db)[0]?.accountAuthorizedTools).toEqual({ search: 'a'.repeat(64) })

    await saveProfiles(db, [{ ...input, accountAuthorizedTools: {} }])
    expect(listProfiles(db)[0]?.accountAuthorizedTools).toEqual({ search: 'a'.repeat(64) })

    await saveProfiles(db, [{ ...input, http: { endpoint: 'https://different-account.example.test/mcp' } }],
      { allowAccountAuthorizationChanges: true })
    expect(listProfiles(db)[0]?.accountAuthorizedTools).toBeUndefined()
  })

  it('clears per-tool account grants after an interactive account reauthorization', async () => {
    const input = makeWriteInput({ enabled: true, transport: 'streamable-http', stdio: undefined,
      http: { endpoint: 'https://account.example.test/mcp' }, enabledToolNames: ['search'],
      accountAuthorizedTools: { search: 'a'.repeat(64) }, alwaysLoad: true })
    await saveProfiles(db, [input], { allowAccountAuthorizationChanges: true })
    expect(listProfiles(db)[0]?.alwaysLoad).toBe(true)
    await clearMcpAccountAuthorizations(db, input.id)
    expect(listProfiles(db)[0]?.accountAuthorizedTools).toBeUndefined()
    expect(listProfiles(db)[0]?.alwaysLoad).toBe(true)
  })

  it('persists allowPrivateNetwork through save and append round-trips', async () => {
    const httpInput = makeWriteInput({
      transport: 'streamable-http',
      stdio: undefined,
      http: { endpoint: 'https://intranet.example.com/mcp', allowPrivateNetwork: true }
    })
    await saveProfiles(db, [httpInput])
    // 落库读回（saveProfilesLocked 转换点）不丢开关
    expect(listProfiles(db).find((p) => p.id === httpInput.id)?.http?.allowPrivateNetwork).toBe(true)

    // append 另一个服务（existingProfilesAsWriteInputs 合并路径）不得静默洗掉已开启的开关
    await appendServer(
      db,
      makeWriteInput({
        id: '22222222-2222-4333-8444-555555555555',
        name: 'Other',
        transport: 'streamable-http',
        stdio: undefined,
        http: { endpoint: 'https://example.com/mcp' }
      })
    )
    expect(listProfiles(db).find((p) => p.id === httpInput.id)?.http?.allowPrivateNetwork).toBe(true)

    // 关闭语义：字段缺省视为关闭，重存后不残留
    await saveProfiles(db, [{ ...httpInput, http: { endpoint: 'https://intranet.example.com/mcp' } }])
    expect(listProfiles(db).find((p) => p.id === httpInput.id)?.http?.allowPrivateNetwork).toBeUndefined()
  })

  it('saveProfiles stores secrets without requiring system safeStorage', async () => {
    const input = makeWriteInput({
      auth: { mode: 'bearer-token', accessToken: 'ghp_abc' },
      enabled: true
    })
    const saved = await saveProfiles(db, [input])

    expect(saved).toHaveLength(1)
    expect(saved[0]!.auth.secretPresent).toBe(true)
    expect(saved[0]!.createdAt).toBeTruthy()
    expect(saved[0]!.updatedAt).toBeTruthy()
    expect(await getSecret(db, input.id, 'access-token')).toBe('ghp_abc')
  })

  it('saveProfiles encrypts header value and env values as secrets', async () => {
    const input = makeWriteInput({
      auth: { mode: 'custom-header', headerName: 'x-api-key', valuePrefix: 'Bearer ', headerValue: 'sk-test' },
      stdio: {
        command: 'node',
        args: [],
        env: [{ key: 'GITHUB_TOKEN', valuePresent: false, value: 'ghp_env' }]
      }
    })
    await saveProfiles(db, [input])

    expect(await getSecret(db, input.id, 'auth-header')).toBe('sk-test')
    expect(await getSecret(db, input.id, 'env:GITHUB_TOKEN')).toBe('ghp_env')
  })

  it('saveProfiles rejects more than the server cap', async () => {
    const inputs = Array.from({ length: MCP_MAX_SERVERS + 1 }, (_, i) =>
      makeWriteInput({ id: `id-${i}`, name: `S${i}` })
    )
    await expect(saveProfiles(db, inputs)).rejects.toThrow(/最多配置/)
  })

  it('saveProfiles rejects duplicate names case-insensitively', async () => {
    const inputs = [
      makeWriteInput({ id: 'id-1', name: 'GitHub' }),
      makeWriteInput({ id: 'id-2', name: 'github' })
    ]
    await expect(saveProfiles(db, inputs)).rejects.toThrow(/重复/)
  })

  it('saveProfiles removes secrets, cache and diagnostics for deleted servers', async () => {
    await saveProfiles(db, [
      makeWriteInput({ id: 'id-1', name: 'A', auth: { mode: 'bearer-token', accessToken: 'token-a' } }),
      makeWriteInput({ id: 'id-2', name: 'B' })
    ])
    await saveToolCache(db, 'id-1', {
      tools: [],
      protocolVersion: '2025-06-18',
      discoveredAt: new Date().toISOString()
    })
    await appendDiagnostic(db, 'id-1', { code: 'init_failed', message: 'boom' })
    await clearDiagnostics(db, 'id-2')

    await saveProfiles(db, [makeWriteInput({ id: 'id-2', name: 'B' })])

    expect(await getSecret(db, 'id-1', 'access-token')).toBeNull()
    expect(getToolCache(db, 'id-1')).toBeNull()
    expect(getDiagnostics(db, 'id-1')).toEqual([])
    expect(listProfiles(db).map((p) => p.id)).toEqual(['id-2'])
  })

  it('saveProfiles applies clearSecretKinds', async () => {
    const input = makeWriteInput({
      auth: { mode: 'bearer-token', accessToken: 'token-a' }
    })
    await saveProfiles(db, [input])
    expect(await getSecret(db, input.id, 'access-token')).toBe('token-a')

    await saveProfiles(db, [makeWriteInput({ clearSecretKinds: ['access-token'] })])
    expect(await getSecret(db, input.id, 'access-token')).toBeNull()
    expect(listProfiles(db)[0]!.auth.secretPresent).toBe(false)
  })

  it('saveProfiles preserves createdAt and bumps updatedAt on update', async () => {
    await saveProfiles(db, [makeWriteInput()])
    const first = listProfiles(db)[0]!
    await saveProfiles(db, [makeWriteInput({ name: 'GitHub 2' })])
    const second = listProfiles(db)[0]!
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.name).toBe('GitHub 2')
  })

  it('saveProfiles rolls back metadata when encryption fails (no half-finished state)', async () => {
    vi.mocked(secureApiKey.encryptSecret).mockImplementation(() => {
      throw new Error('AES-GCM encryption failed')
    })

    await expect(
      saveProfiles(db, [
        makeWriteInput({ auth: { mode: 'bearer-token', accessToken: 'token-a' } })
      ])
    ).rejects.toThrow(/AES-GCM/)

    expect(listProfiles(db)).toEqual([])
    expect(getConfigValue(db, MCP_SECRETS_CONFIG_KEY)).toBeUndefined()
  })

  it('deleteServer removes profile, secrets, cache and diagnostics', async () => {
    await saveProfiles(db, [
      makeWriteInput({ id: 'id-1', name: 'A', auth: { mode: 'bearer-token', accessToken: 'token-a' } }),
      makeWriteInput({ id: 'id-2', name: 'B' })
    ])
    await saveToolCache(db, 'id-1', {
      tools: [],
      protocolVersion: '2025-06-18',
      discoveredAt: new Date().toISOString()
    })
    await appendDiagnostic(db, 'id-1', { code: 'x', message: 'y' })

    await deleteServer(db, 'id-1')

    expect(listProfiles(db).map((p) => p.id)).toEqual(['id-2'])
    expect(await getSecret(db, 'id-1', 'access-token')).toBeNull()
    expect(getToolCache(db, 'id-1')).toBeNull()
    expect(getDiagnostics(db, 'id-1')).toEqual([])
  })

  it('round-trips tool cache per server', async () => {
    const entry = {
      tools: [
        {
          serverId: 'id-1',
          originalName: 'create_issue',
          mappedName: 'mcp_github_create_issue_12345678',
          description: 'creates an issue',
          inputSchema: { type: 'object' },
          discoveredAt: new Date().toISOString()
        }
      ],
      protocolVersion: '2025-06-18',
      discoveredAt: new Date().toISOString()
    }
    await saveProfiles(db, [makeWriteInput({ id: 'id-1' })])
    await saveToolCache(db, 'id-1', entry)
    expect(getToolCache(db, 'id-1')).toEqual(entry)
    expect(getToolCache(db, 'id-2')).toBeNull()
    clearToolCache(db, 'id-1')
    expect(getToolCache(db, 'id-1')).toBeNull()
  })

  it('updateServerStatus patches status and lastError without touching secrets', async () => {
    await saveProfiles(db, [
      makeWriteInput({ id: 'id-1', name: 'A', auth: { mode: 'bearer-token', accessToken: 'token-a' } })
    ])

    await updateServerStatus(db, 'id-1', {
      status: 'connected',
      discoveredProtocolVersion: '2025-06-18',
      lastError: { code: 'init_failed', message: 'boom', occurredAt: new Date().toISOString() }
    })

    const profile = listProfiles(db)[0]!
    expect(profile.status).toBe('connected')
    expect(profile.discoveredProtocolVersion).toBe('2025-06-18')
    expect(profile.lastError?.code).toBe('init_failed')
    expect(await getSecret(db, 'id-1', 'access-token')).toBe('token-a')

    await updateServerStatus(db, 'id-1', { status: 'no-tools' })
    expect(listProfiles(db)[0]!.status).toBe('no-tools')
  })

  it('refreshProfilesSecretFlags recomputes secretPresent from the secret map', async () => {
    await saveProfiles(db, [
      makeWriteInput({ id: 'id-1', name: 'A', auth: { mode: 'bearer-token', accessToken: 'token-a' } })
    ])
    expect(listProfiles(db)[0]!.auth.secretPresent).toBe(true)

    const { clearSecret } = await import('./mcpSecretStore')
    await clearSecret(db, 'id-1', 'access-token')

    const refreshed = refreshProfilesSecretFlags(db)
    expect(refreshed[0]!.auth.secretPresent).toBe(false)
  })
})
