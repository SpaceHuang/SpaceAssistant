import { describe, expect, it } from 'vitest'
import { resolvePublicMcpReadAuthorization } from './publicMcpReadTrust'
import { hashMcpToolDescription, hashMcpToolSchema } from './mcpToolRegistry'
import { createMemoryAppDb } from '../database/testHelpers'
import { listProfiles, saveProfiles } from './mcpConfigStore'

const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
const annotations = { readOnlyHint: true, destructiveHint: false }
const schemaHash = hashMcpToolSchema(schema)
const descriptorHash = hashMcpToolDescription({ serverId: 'server-a', originalName: 'search', description: 'Search public sources', inputSchema: schema, annotations })
const profile = {
  id: 'server-a', enabled: true, enabledToolNames: ['search'],
  publicReadOnlyTools: { search: descriptorHash }
}
const entry = {
  serverId: 'server-a', originalName: 'search', mappedName: 'mcp_docs_search',
  descriptorHash, schemaHash, description: 'Search public sources', annotations, inputSchema: schema
}

describe('host-authored public MCP read trust', () => {
  it('resolves public source and account authorization only for an enabled, explicitly trusted exact descriptor', () => {
    expect(resolvePublicMcpReadAuthorization(profile, entry)).toEqual({ querySource: 'public', accountAuthorization: 'unknown' })
  })

  it.each([
    ['missing profile trust', { ...profile, publicReadOnlyTools: {} }, entry],
    ['disabled server', { ...profile, enabled: false }, entry],
    ['tool not enabled', { ...profile, enabledToolNames: [] }, entry],
    ['changed descriptor', profile, { ...entry, descriptorHash: 'c'.repeat(64) }],
    ['missing descriptor hash', profile, { ...entry, descriptorHash: undefined }],
    ['different server identity', profile, { ...entry, serverId: 'server-b' }],
    ['write annotation', profile, { ...entry, annotations: { readOnlyHint: false, destructiveHint: true } }]
  ])('fails closed for %s', (_case, candidateProfile, candidateEntry) => {
    expect(resolvePublicMcpReadAuthorization(candidateProfile, candidateEntry)).toEqual({ querySource: 'unknown', accountAuthorization: 'unknown' })
  })

  it('fails closed when an otherwise eligible profile is disabled or its user-selected tool is no longer enabled', () => {
    expect(resolvePublicMcpReadAuthorization({ ...profile, enabled: false }, entry).querySource).toBe('unknown')
    expect(resolvePublicMcpReadAuthorization({ ...profile, enabledToolNames: [] }, entry).accountAuthorization).toBe('unknown')
  })

  it('does not infer account or resource authorization from a configured credential and successful connection', () => {
    const authenticatedProfile = {
      ...profile,
      auth: { mode: 'oauth' as const, secretPresent: true },
      status: 'connected' as const
    }
    expect(resolvePublicMcpReadAuthorization(authenticatedProfile, entry)).toEqual({
      querySource: 'public', accountAuthorization: 'unknown'
    })
  })

  it('accepts only explicit host account-use authorization bound to the exact descriptor', () => {
    const accountGranted = { ...profile, publicReadOnlyTools: undefined, accountAuthorizedTools: { search: descriptorHash } }
    expect(resolvePublicMcpReadAuthorization(accountGranted, entry)).toEqual({
      querySource: 'unknown', accountAuthorization: 'authorized'
    })
    expect(resolvePublicMcpReadAuthorization({ ...profile, accountAuthorizedTools: { search: 'c'.repeat(64) } }, entry)).toEqual({
      querySource: 'public', accountAuthorization: 'unknown'
    })
    expect(resolvePublicMcpReadAuthorization({ ...accountGranted, enabled: false }, entry).accountAuthorization).toBe('unknown')
    expect(resolvePublicMcpReadAuthorization(accountGranted, { ...entry, descriptorHash: 'c'.repeat(64) }).accountAuthorization).toBe('unknown')
  })

  it('does not let a direct profile-store caller create trust without the settings IPC opt-in', async () => {
    const db = createMemoryAppDb()
    try {
      await saveProfiles(db, [{ id: 'server-a', name: 'Docs', enabled: true, transport: 'stdio', timeoutSec: 10,
        auth: { mode: 'none' }, stdio: { command: 'node', args: ['server.js'], env: [] }, enabledToolNames: ['search'],
        publicReadOnlyTools: { search: descriptorHash } }])
      expect(listProfiles(db)[0]?.publicReadOnlyTools).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
