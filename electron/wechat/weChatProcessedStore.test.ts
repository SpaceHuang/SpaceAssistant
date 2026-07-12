import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { WeChatProcessedStore } from './weChatProcessedStore'

describe('WeChatProcessedStore', () => {
  it('deduplicates message ids', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wx-store-'))
    const store = new WeChatProcessedStore(dir)
    await store.mark('m1')
    expect(await store.has('m1')).toBe(true)
    await store.mark('m1')
    expect(await store.has('m2')).toBe(false)
  })
})
