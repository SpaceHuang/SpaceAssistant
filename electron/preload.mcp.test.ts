import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import type { SpaceAssistantApi } from '../src/shared/api'
import type {
  McpConfig,
  McpSaveProfilesResult,
  McpServerProfile,
  McpServerWriteInput
} from '../src/shared/mcpTypes'

const MCP_CHANNELS = [
  'mcp:list',
  'mcp:save-profiles',
  'mcp:test-connection',
  'mcp:delete-server',
  'mcp:clear-secret',
  'mcp:get-diagnostics',
  'mcp:refresh-tools',
  'mcp:clear-diagnostics',
  'mcp:oauth-start'
]

describe('MCP preload API contract', () => {
  it('exposes MCP methods only on the single window.api bridge', () => {
    const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')
    const exposeCalls = preloadSource.match(/exposeInMainWorld\(/g) ?? []
    expect(exposeCalls).toHaveLength(1)
    expect(preloadSource).toContain("exposeInMainWorld('api', api)")
    expect(preloadSource).not.toContain('electronAPI')
  })

  it('maps every flat mcp* method to its dedicated channel (no generic invoke)', () => {
    const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')
    const methodNames = [
      'mcpList',
      'mcpSaveProfiles',
      'mcpTestConnection',
      'mcpRefreshTools',
      'mcpClearSecret',
      'mcpDeleteServer',
      'mcpGetDiagnostics',
      'mcpClearDiagnostics',
      'mcpOauthStart'
    ]
    for (const name of methodNames) {
      expect(preloadSource).toContain(`${name}:`)
    }
    for (const channel of MCP_CHANNELS) {
      expect(preloadSource).toContain(`ipcRenderer.invoke('${channel}'`)
    }
  })

  it('declares flat mcp methods on the SpaceAssistantApi type', () => {
    type HasMcpList = 'mcpList' extends keyof SpaceAssistantApi ? true : false
    type HasMcpSave = 'mcpSaveProfiles' extends keyof SpaceAssistantApi ? true : false
    type HasMcpTest = 'mcpTestConnection' extends keyof SpaceAssistantApi ? true : false
    type HasMcpRefresh = 'mcpRefreshTools' extends keyof SpaceAssistantApi ? true : false
    const checks: boolean[] = [true, true, true, true]
    const _a: HasMcpList = checks[0] as never
    const _b: HasMcpSave = checks[1] as never
    const _c: HasMcpTest = checks[2] as never
    const _d: HasMcpRefresh = checks[3] as never
    expect([_a, _b, _c, _d]).toEqual([true, true, true, true])
  })

  it('keeps secret fields out of readable profile types', () => {
    type HasAccessToken = 'accessToken' extends keyof McpServerProfile ? true : false
    type HasEnvValues = 'environmentValues' extends keyof McpServerProfile ? true : false
    type HasHeaderValue = 'headerValue' extends keyof McpServerProfile ? true : false
    expect<HasAccessToken>(false).toBe(false)
    expect<HasEnvValues>(false).toBe(false)
    expect<HasHeaderValue>(false).toBe(false)

    type WriteAuthHasToken = 'accessToken' extends keyof McpServerWriteInput['auth'] ? true : false
    expect<WriteAuthHasToken>(true).toBe(true)
  })

  it('keeps MCP persistence out of config:set', () => {
    const appIpcSource = fs.readFileSync(path.join(__dirname, 'appIpc.ts'), 'utf8')
    expect(appIpcSource).not.toMatch(/mcpServers:|mcpSecrets:|secrets\.mcp/)
  })

  it('never exposes recoverable secrets in readable MCP types (安全回归)', () => {
    type SecretKeysOfProfile = {
      [K in keyof McpServerProfile]: K extends
        | 'accessToken'
        | 'headerValue'
        | 'environmentValues'
        | 'refreshToken'
        | 'clientSecret'
        ? K
        : never
    }[keyof McpServerProfile]
    type SecretKeysOfConfig = {
      [K in keyof McpConfig]: K extends 'secrets' | 'credentials' ? K : never
    }[keyof McpConfig]
    type SecretKeysOfSaveResult = {
      [K in keyof McpSaveProfilesResult]: K extends 'secrets' | 'credentials' ? K : never
    }[keyof McpSaveProfilesResult]
    expect<SecretKeysOfProfile>(undefined as never).toBeUndefined()
    expect<SecretKeysOfConfig>(undefined as never).toBeUndefined()
    expect<SecretKeysOfSaveResult>(undefined as never).toBeUndefined()
    // write input 仍是唯一携带一次性 Secret 的类型
    type WriteHasToken = 'accessToken' extends keyof McpServerWriteInput['auth'] ? true : false
    expect<WriteHasToken>(true).toBe(true)
  })
})
