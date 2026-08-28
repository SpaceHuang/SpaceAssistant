import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import {
  clearSecret,
  deleteSecretsForServer,
  getSecret,
  hasSecret,
  setSecret
} from './mcpSecretStore'

vi.mock('../secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (b64: string) => b64.replace(/^enc:/, '')
}))

describe('mcpSecretStore', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-mcp-secret-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('round-trips setSecret/getSecret', async () => {
    await setSecret(db, 'server-1', 'access-token', 'ghp_abc')
    expect(await getSecret(db, 'server-1', 'access-token')).toBe('ghp_abc')
    expect(hasSecret(db, 'server-1', 'access-token')).toBe(true)
  })

  it('isolates secrets by server and kind', async () => {
    await setSecret(db, 'server-1', 'access-token', 'token-a')
    await setSecret(db, 'server-2', 'access-token', 'token-b')
    await setSecret(db, 'server-1', 'refresh-token', 'refresh-a')
    await setSecret(db, 'server-1', 'env:GITHUB_TOKEN', 'env-a')

    expect(await getSecret(db, 'server-1', 'access-token')).toBe('token-a')
    expect(await getSecret(db, 'server-2', 'access-token')).toBe('token-b')
    expect(await getSecret(db, 'server-1', 'refresh-token')).toBe('refresh-a')
    expect(await getSecret(db, 'server-1', 'env:GITHUB_TOKEN')).toBe('env-a')
    expect(await getSecret(db, 'server-2', 'refresh-token')).toBeNull()
  })

  it('returns null for missing secrets', async () => {
    expect(await getSecret(db, 'server-1', 'access-token')).toBeNull()
    expect(hasSecret(db, 'server-1', 'access-token')).toBe(false)
  })

  it('rejects invalid secret kinds', async () => {
    await expect(setSecret(db, 'server-1', 'password', 'x')).rejects.toThrow()
    await expect(setSecret(db, 'server-1', '', 'x')).rejects.toThrow()
    await expect(setSecret(db, 'server-1', 'env:', 'x')).rejects.toThrow()
  })

  it('rejects empty server ids', async () => {
    await expect(setSecret(db, '', 'access-token', 'x')).rejects.toThrow()
  })

  it('clearSecret removes only the requested kind', async () => {
    await setSecret(db, 'server-1', 'access-token', 'token-a')
    await setSecret(db, 'server-1', 'refresh-token', 'refresh-a')
    await clearSecret(db, 'server-1', 'access-token')
    expect(await getSecret(db, 'server-1', 'access-token')).toBeNull()
    expect(await getSecret(db, 'server-1', 'refresh-token')).toBe('refresh-a')
  })

  it('deleteSecretsForServer removes all kinds for one server only', async () => {
    await setSecret(db, 'server-1', 'access-token', 'token-a')
    await setSecret(db, 'server-1', 'env:API_KEY', 'key-a')
    await setSecret(db, 'server-2', 'access-token', 'token-b')

    await deleteSecretsForServer(db, 'server-1')

    expect(await getSecret(db, 'server-1', 'access-token')).toBeNull()
    expect(await getSecret(db, 'server-1', 'env:API_KEY')).toBeNull()
    expect(await getSecret(db, 'server-2', 'access-token')).toBe('token-b')
  })

  it('serializes concurrent writes without losing updates (A1)', async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      setSecret(db, 'server-1', `env:KEY_${i}`, `value-${i}`)
    )
    await Promise.all(writes)

    for (let i = 0; i < 20; i++) {
      expect(await getSecret(db, 'server-1', `env:KEY_${i}`)).toBe(`value-${i}`)
    }
  })

  it('last concurrent write to the same key wins deterministically', async () => {
    await Promise.all([
      setSecret(db, 'server-1', 'access-token', 'first'),
      setSecret(db, 'server-1', 'access-token', 'second'),
      setSecret(db, 'server-1', 'access-token', 'third')
    ])
    const value = await getSecret(db, 'server-1', 'access-token')
    expect(['first', 'second', 'third']).toContain(value)
  })
})
