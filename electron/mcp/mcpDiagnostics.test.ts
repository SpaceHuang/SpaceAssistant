import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import { setSecret } from './mcpSecretStore'
import {
  MCP_DIAGNOSTICS_MAX_PER_SERVER,
  MCP_DIAGNOSTICS_RETENTION_MS
} from '../../src/shared/mcpTypes'
import { appendDiagnostic, clearDiagnostics, getDiagnostics } from './mcpDiagnostics'

vi.mock('../secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (b64: string) => b64.replace(/^enc:/, '')
}))

describe('mcpDiagnostics', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-mcp-diag-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('round-trips appended diagnostics', async () => {
    await appendDiagnostic(db, 'server-1', { code: 'init_failed', message: 'connection refused' })
    const entries = getDiagnostics(db, 'server-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.code).toBe('init_failed')
    expect(entries[0]!.message).toBe('connection refused')
    expect(entries[0]!.occurredAt).toBeTruthy()
    expect(entries[0]!.id).toBeTruthy()
  })

  it('caps at the per-server limit and drops the oldest entries', async () => {
    for (let i = 0; i < MCP_DIAGNOSTICS_MAX_PER_SERVER + 5; i++) {
      await appendDiagnostic(db, 'server-1', { code: 'x', message: `entry-${i}` })
    }
    const entries = getDiagnostics(db, 'server-1')
    expect(entries).toHaveLength(MCP_DIAGNOSTICS_MAX_PER_SERVER)
    expect(entries.some((e) => e.message === 'entry-0')).toBe(false)
    expect(entries[entries.length - 1]!.message).toBe(`entry-${MCP_DIAGNOSTICS_MAX_PER_SERVER + 4}`)
  })

  it('drops entries older than the retention window on append', async () => {
    const now = Date.now()
    await appendDiagnostic(db, 'server-1', { code: 'old', message: 'old' }, now - MCP_DIAGNOSTICS_RETENTION_MS - 1000)
    await appendDiagnostic(db, 'server-1', { code: 'new', message: 'new' }, now)
    const entries = getDiagnostics(db, 'server-1')
    expect(entries.map((e) => e.message)).toEqual(['new'])
  })

  it('keeps diagnostics isolated per server', async () => {
    await appendDiagnostic(db, 'server-1', { code: 'a', message: 'a' })
    await appendDiagnostic(db, 'server-2', { code: 'b', message: 'b' })
    expect(getDiagnostics(db, 'server-1').map((e) => e.message)).toEqual(['a'])
    expect(getDiagnostics(db, 'server-2').map((e) => e.message)).toEqual(['b'])
  })

  it('sanitizes common token formats in messages', async () => {
    await appendDiagnostic(db, 'server-1', {
      code: 'call_failed',
      message: 'authorization failed for sk-ant-api03-abcdef token'
    })
    expect(getDiagnostics(db, 'server-1')[0]!.message).not.toContain('sk-ant-api03-abcdef')
  })

  it('masks literal occurrences of known secrets for that server only', async () => {
    await setSecret(db, 'server-1', 'access-token', 'ghp_supersecret')
    await appendDiagnostic(db, 'server-1', {
      code: 'call_failed',
      message: 'server rejected ghp_supersecret for user'
    })
    await appendDiagnostic(db, 'server-2', {
      code: 'call_failed',
      message: 'server rejected ghp_supersecret for user'
    })
    expect(getDiagnostics(db, 'server-1')[0]!.message).toContain('[REDACTED]')
    expect(getDiagnostics(db, 'server-1')[0]!.message).not.toContain('ghp_supersecret')
    // server-2 has no secret configured; its message keeps the literal (defense covered by base sanitizer
    // for known token formats; here the token shape is not standard so it is preserved for diagnosis).
    expect(getDiagnostics(db, 'server-2')[0]!.message).toContain('ghp_supersecret')
  })

  it('clearDiagnostics empties the list', async () => {
    await appendDiagnostic(db, 'server-1', { code: 'a', message: 'a' })
    clearDiagnostics(db, 'server-1')
    expect(getDiagnostics(db, 'server-1')).toEqual([])
  })
})
