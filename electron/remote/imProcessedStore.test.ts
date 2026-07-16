import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAIM_LEASE_MS, ImProcessedStore } from './imProcessedStore'

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

  it('tryClaim is atomic — second claim fails', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-processed-'))
    const store = new ImProcessedStore({ channel: 'feishu', userDataDir: tempDir, logEvent })
    const a = await store.tryClaim('m1')
    const b = await store.tryClaim('m1')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(false)
  })

  it('claimed → executing → completed', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-processed-'))
    const store = new ImProcessedStore({ channel: 'wechat', userDataDir: tempDir, logEvent })
    const c = await store.tryClaim('m2')
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(await store.markExecuting('m2', c.claimId)).toBe(true)
    expect(await store.markCompleted('m2', c.claimId, 'ok')).toBe(true)
    expect(await store.has('m2')).toBe(true)
    expect((await store.tryClaim('m2')).ok).toBe(false)
  })

  it('concurrent claims on different ids do not clobber', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-processed-'))
    const store = new ImProcessedStore({ channel: 'feishu', userDataDir: tempDir, logEvent })
    const [a, b] = await Promise.all([store.tryClaim('x1'), store.tryClaim('x2')])
    expect(a.ok && b.ok).toBe(true)
  })

  it('expired claimed can be reclaimed after recover', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-processed-'))
    const store = new ImProcessedStore({ channel: 'feishu', userDataDir: tempDir, logEvent })
    const past = Date.now() - CLAIM_LEASE_MS - 1000
    const c = await store.tryClaim('old', past)
    expect(c.ok).toBe(true)
    const again = await store.tryClaim('old')
    expect(again.ok).toBe(true)
  })

  it('legacy mark still works', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'im-processed-'))
    const store = new ImProcessedStore({ channel: 'feishu', userDataDir: tempDir, logEvent })
    expect(await store.has('m1')).toBe(false)
    await store.mark('m1')
    expect(await store.has('m1')).toBe(true)
  })
})
