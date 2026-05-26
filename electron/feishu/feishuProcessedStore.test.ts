import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { FeishuProcessedStore } from './feishuProcessedStore'

describe('FeishuProcessedStore', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-store-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('deduplicates message ids', async () => {
    const store = new FeishuProcessedStore(tmpDir)
    expect(await store.has('m1')).toBe(false)
    await store.mark('m1')
    expect(await store.has('m1')).toBe(true)
  })

  it('purges entries older than 7 days', async () => {
    const store = new FeishuProcessedStore(tmpDir)
    await store.mark('old', Date.now() - 8 * 24 * 60 * 60 * 1000)
    store.purgeExpired()
    expect(await store.has('old')).toBe(false)
  })
})
