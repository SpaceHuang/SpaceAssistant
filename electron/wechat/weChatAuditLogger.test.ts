import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { WeChatAuditLogger } from './weChatAuditLogger'

describe('WeChatAuditLogger', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-audit-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('appends and tails audit entries', async () => {
    const logger = new WeChatAuditLogger(tmpDir)
    await logger.append({ type: 'reply', messageId: 'm1', len: 10, targetId: 'u1', success: true })
    const rows = await logger.tail(10)
    expect(rows.length).toBe(1)
    expect(rows[0].type).toBe('reply')
  })

  it('filters by type in query', async () => {
    const logger = new WeChatAuditLogger(tmpDir)
    await logger.append({ type: 'inbound', messageId: 'm1', chatId: 'c', senderId: 's', accepted: true })
    await logger.append({ type: 'rate_limit', senderId: 's' })
    const result = await logger.query({ types: ['rate_limit'] })
    expect(result.events.every((e) => e.type === 'rate_limit')).toBe(true)
  })
})
