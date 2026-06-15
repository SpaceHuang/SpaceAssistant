import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('fileContentWatcher', () => {
  let tmpDir: string
  let sendMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fcw-test-'))
    sendMock = vi.fn()
    const { stopAllContentWatches } = await import('./fileContentWatcher')
    stopAllContentWatches()
  })

  afterEach(async () => {
    const { stopAllContentWatches } = await import('./fileContentWatcher')
    stopAllContentWatches()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('pushes file:content-changed immediately on file change', async () => {
    const filePath = path.join(tmpDir, 'watch.txt')
    await fs.writeFile(filePath, 'v1', 'utf8')

    const { startContentWatch, getWatchedRelPathForTests } = await import('./fileContentWatcher')
    const sender = { send: sendMock, isDestroyed: () => false } as never

    startContentWatch(tmpDir, 'watch.txt', sender)
    expect(getWatchedRelPathForTests()).toBe('watch.txt')

    await fs.writeFile(filePath, 'v2', 'utf8')
    await new Promise((r) => setTimeout(r, 100))

    expect(sendMock).toHaveBeenCalledWith('file:content-changed', { relPath: 'watch.txt' })
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
