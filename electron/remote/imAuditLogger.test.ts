import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImAuditLogger } from './imAuditLogger'

type TestAuditEvent = { type: string; ts?: number; detail?: string }

describe('ImAuditLogger', () => {
  let tempDir = ''
  const logMirror = vi.fn()

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
    logMirror.mockClear()
  })

  function createLogger(opts?: { retentionMs?: number; maxFileBytes?: number }) {
    return new ImAuditLogger<TestAuditEvent>({
      channel: 'feishu',
      userDataDir: tempDir,
      maxFileBytes: opts?.maxFileBytes ?? 1024 * 1024,
      maxBackups: 3,
      retentionMs: opts?.retentionMs,
      logMirror,
      logFileName: 'test-audit.log'
    })
  }

  it('append, tail, and query with truncation', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-audit-'))
    const logger = createLogger()

    await logger.append({ type: 'inbound', detail: 'a' })
    await logger.append({ type: 'rate_limit', detail: 'b' })

    const tail = await logger.tail(10)
    expect(tail).toHaveLength(2)
    expect(logMirror).toHaveBeenCalledTimes(2)

    const result = await logger.query({ types: ['rate_limit'], limit: 1 })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.type).toBe('rate_limit')
    expect(result.total).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('purgeExpired removes old entries when retentionMs set', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-audit-'))
    const logger = createLogger({ retentionMs: 1000 })
    const oldTs = Date.now() - 5000

    await logger.append({ type: 'old', ts: oldTs })
    await logger.append({ type: 'new', ts: Date.now() })
    await logger.purgeExpired()

    const tail = await logger.tail(10)
    expect(tail.map((e) => e.type)).toEqual(['new'])
  })
})
