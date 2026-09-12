import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { BoundedOutputBuffer } from './boundedOutput'
import { cleanupExpiredOutputArtifacts } from './outputArtifactCleanup'
import { ExecutionLifecycle } from './executionLifecycle'
import { ProgressThrottle } from './progressThrottle'

describe('shell lifecycle local benchmark fixture', () => {
  // §9.2：缓冲区现在只处理原始字节，文本是快照之上的投影（不再由缓冲自行拼接文本）。
  it('100MB output remains bounded while bytes are fully counted', () => {
    const buffer = new BoundedOutputBuffer(4096)
    const chunk = Buffer.alloc(64 * 1024, 65)
    for (let i = 0; i < 1600; i++) buffer.appendBytes(chunk)
    const snapshot = buffer.snapshotBytes()
    expect(snapshot.totalBytes).toBe(100 * 1024 * 1024)
    // head=limit、tail=limit/2（§9.2），保留量上界为 1.5 * limit
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(4096 + 2048)
    expect(snapshot.head.length).toBe(4096)
    expect(snapshot.tail.length).toBe(2048)
    expect(snapshot.omittedBytes).toBe(100 * 1024 * 1024 - snapshot.retainedBytes)
    expect(snapshot.truncated).toBe(true)
  })

  it('progress 事件受时间和每秒预算限制', () => {
    const throttle = new ProgressThrottle({ minIntervalMs: 50, maxEventsPerSecond: 20, minBytes: 1 })
    let sent = 0
    for (let i = 0; i < 1000; i++) if (throttle.shouldSend(1000 + i, 1)) sent++
    expect(sent).toBeLessThanOrEqual(20)
  })

  it('artifact cleanup 与 lifecycle settle 都是有限且幂等的', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-lifecycle-benchmark-'))
    try {
      await fs.writeFile(path.join(dir, 'old.log'), 'old')
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      await fs.utimes(path.join(dir, 'old.log'), old, old)
      await cleanupExpiredOutputArtifacts(dir, 7 * 24 * 60 * 60 * 1000)
      await expect(fs.access(path.join(dir, 'old.log'))).rejects.toThrow()

      const lifecycle = new ExecutionLifecycle<string>()
      expect(lifecycle.finalize('process_exit', 'first')).toBe(true)
      expect(lifecycle.finalize('process_exit', 'second')).toBe(false)
      expect(lifecycle.state).toEqual({ reason: 'process_exit', value: 'first' })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
