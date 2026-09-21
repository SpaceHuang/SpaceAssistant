import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
vi.mock('./windowRef', () => ({
  getMainWindow: () => ({ webContents: { send: sendMock } })
}))

describe('fileContentWatcher', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fcw-test-'))
    sendMock.mockClear()
    const { stopAllContentWatches } = await import('./fileContentWatcher')
    stopAllContentWatches()
  })

  afterEach(async () => {
    const { stopAllContentWatches } = await import('./fileContentWatcher')
    stopAllContentWatches()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('broadcasts scope:invalidated { file:<path>, version } immediately on file change (偏差 11/3c)', async () => {
    const filePath = path.join(tmpDir, 'watch.txt')
    await fs.writeFile(filePath, 'v1', 'utf8')

    const { startContentWatch, getWatchedRelPathForTests } = await import('./fileContentWatcher')
    // 新契约:不再经 sender 直连;广播走统一出口(windowRef.getMainWindow)
    startContentWatch(tmpDir, 'watch.txt')
    expect(getWatchedRelPathForTests()).toBe('watch.txt')

    await fs.writeFile(filePath, 'v2', 'utf8')
    await new Promise((r) => setTimeout(r, 100))

    const invocations = sendMock.mock.calls.filter((c) => c[0] === 'scope:invalidated')
    expect(invocations.length).toBeGreaterThanOrEqual(1)
    const payload = invocations[0]![1] as { scope: string; version: number }
    expect(payload.scope).toBe('file:watch.txt')
    expect(payload.version).toBeGreaterThan(0)
    // 载荷不含真相(无文件内容字段)
    expect(Object.keys(payload).sort()).toEqual(['scope', 'version'])
  })

  it('stops previous watch when switching files', async () => {
    const a = path.join(tmpDir, 'a.txt')
    const b = path.join(tmpDir, 'b.txt')
    await fs.writeFile(a, 'a', 'utf8')
    await fs.writeFile(b, 'b', 'utf8')

    const { startContentWatch, stopContentWatch, getWatchedRelPathForTests } = await import('./fileContentWatcher')
    const sender = { send: sendMock, isDestroyed: () => false } as never

    startContentWatch(tmpDir, 'a.txt', sender)
    startContentWatch(tmpDir, 'b.txt', sender)
    expect(getWatchedRelPathForTests()).toBe('b.txt')

    stopContentWatch()
    expect(getWatchedRelPathForTests()).toBeNull()
  })

  it('stopContentWatch clears active watch', async () => {
    const filePath = path.join(tmpDir, 'c.txt')
    await fs.writeFile(filePath, 'c', 'utf8')

    const { startContentWatch, stopContentWatch, getWatchedRelPathForTests } = await import('./fileContentWatcher')
    const sender = { send: sendMock, isDestroyed: () => false } as never

    startContentWatch(tmpDir, 'c.txt', sender)
    stopContentWatch()
    expect(getWatchedRelPathForTests()).toBeNull()

    sendMock.mockClear()
    await fs.writeFile(filePath, 'c2', 'utf8')
    await new Promise((r) => setTimeout(r, 100))
    expect(sendMock).not.toHaveBeenCalled()
  })
})
