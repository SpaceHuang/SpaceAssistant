import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImProcessedStore } from './imProcessedStore'

describe('ImProcessedStore', () => {
  let tempDir = ''
  const logEvent = vi.fn()

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
    logEvent.mockClear()
  })

  it('mark and has are idempotent', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-processed-'))
    const store = new ImProcessedStore({ channel: 'feishu', userDataDir: tempDir, logEvent })

    expect(await store.has('m1')).toBe(false)
    await store.mark('m1')
    expect(await store.has('m1')).toBe(true)
    await store.mark('m1')
    expect(logEvent).toHaveBeenCalledTimes(1)
  })

  it('degrades when file is missing', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-processed-'))
    const store = new ImProcessedStore({ channel: 'wechat', userDataDir: tempDir, logEvent })
    expect(await store.has('missing')).toBe(false)
  })
})
