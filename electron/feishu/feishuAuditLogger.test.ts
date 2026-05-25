import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { FeishuAuditLogger } from './feishuAuditLogger'

describe('FeishuAuditLogger', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-audit-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('appends and tails audit entries', async () => {
    const logger = new FeishuAuditLogger(tmpDir)
    await logger.append({ type: 'reply', messageId: 'm1', len: 10 })
    const rows = await logger.tail(10)
    expect(rows.length).toBe(1)
    expect(rows[0].type).toBe('reply')
  })
})
