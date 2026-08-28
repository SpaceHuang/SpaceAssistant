import { describe, expect, it } from 'vitest'
import type { McpServerProfile } from '../../../shared/mcpTypes'
import {
  draftToWriteInput,
  initMcpServerDraft,
  isMcpDraftDirty,
  newMcpServerDraft
} from './mcpDrafts'

function makeProfile(overrides: Partial<McpServerProfile> = {}): McpServerProfile {
  return {
    id: 'server-1',
    name: 'GitHub',
    enabled: false,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none', secretPresent: false },
    stdio: {
      command: 'node',
      args: ['server.js'],
      env: [{ key: 'GITHUB_TOKEN', valuePresent: true }]
    },
    enabledToolNames: [],
    toolConfirmPolicy: 'always',
    status: 'untested',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    ...overrides
  }
}

describe('mcpDrafts', () => {
  it('creates a blank draft with a unique id', () => {
    const a = newMcpServerDraft()
    const b = newMcpServerDraft()
    expect(a.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
    expect(a.name).toBe('')
    expect(a.enabled).toBe(false)
    expect(a.transport).toBe('stdio')
    expect(a.toolConfirmPolicy).toBe('readonly-auto')
  })

  it('initializes a draft from a stored profile without secret values', () => {
    const draft = initMcpServerDraft(makeProfile())
    expect(draft.name).toBe('GitHub')
    expect(draft.stdio?.env).toEqual([{ key: 'GITHUB_TOKEN', value: '', valuePresent: true }])
    expect(draft.auth.accessToken).toBeUndefined()
  })

  it('converts a draft to a write input carrying one-time secrets', () => {
    const draft = initMcpServerDraft(makeProfile())
    draft.auth = { mode: 'bearer-token', accessToken: 'ghp_x' }
    draft.stdio!.env[0]!.value = 'env-value'
    const input = draftToWriteInput(draft)
    expect(input.auth.accessToken).toBe('ghp_x')
    expect(input.stdio?.env[0]).toMatchObject({ key: 'GITHUB_TOKEN', value: 'env-value' })
    expect(input).not.toHaveProperty('status')
  })

  it('emits only the active transport group in write input', () => {
    const draft = initMcpServerDraft(makeProfile())
    // 模拟切换 Tab 后保留的另一组字段：stdio 数据仍在，但当前传输是 HTTP
    draft.transport = 'streamable-http'
    draft.http = { endpoint: 'https://example.com/mcp' }
    const input = draftToWriteInput(draft)
    expect(input.http?.endpoint).toBe('https://example.com/mcp')
    expect(input.stdio).toBeUndefined()

    draft.transport = 'stdio'
    const backToStdio = draftToWriteInput(draft)
    expect(backToStdio.stdio?.command).toBe('node')
    expect(backToStdio.http).toBeUndefined()
  })

  it('marks a draft dirty when secrets are entered or fields change', () => {
    const profile = makeProfile()
    const draft = initMcpServerDraft(profile)
    expect(isMcpDraftDirty(profile, draft)).toBe(false)

    const withToken = { ...draft, auth: { mode: 'bearer-token', accessToken: 'ghp_x' } }
    expect(isMcpDraftDirty(profile, withToken)).toBe(true)

    const renamed = { ...draft, name: 'GitHub 2' }
    expect(isMcpDraftDirty(profile, renamed)).toBe(true)

    const withClear = {
      ...draft,
      stdio: { ...draft.stdio!, env: [{ key: 'GITHUB_TOKEN', value: '', valuePresent: true, clear: true }] }
    }
    expect(isMcpDraftDirty(profile, withClear)).toBe(true)
  })

  it('keeps unchanged drafts clean', () => {
    const profile = makeProfile({
      auth: { mode: 'custom-header', secretPresent: true, headerName: 'x-api-key', valuePrefix: 'Bearer ' }
    })
    const draft = initMcpServerDraft(profile)
    draft.auth.headerName = 'x-api-key'
    draft.auth.valuePrefix = 'Bearer '
    expect(isMcpDraftDirty(profile, draft)).toBe(false)
  })

  it('drops stale env clears when the same key is re-added with a value', () => {
    const draft = initMcpServerDraft(makeProfile())
    draft.stdio!.env = draft.stdio!.env.filter((e) => e.key !== 'GITHUB_TOKEN')
    draft.clearSecretKinds = ['env:GITHUB_TOKEN']
    draft.stdio!.env = [{ key: 'GITHUB_TOKEN', value: 'new-value', valuePresent: false }]
    const input = draftToWriteInput(draft)
    expect(input.clearSecretKinds).toBeUndefined()
    expect(input.stdio?.env[0]).toMatchObject({ key: 'GITHUB_TOKEN', value: 'new-value' })
  })
})
