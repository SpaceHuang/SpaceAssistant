import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { READ_FILE_MAX_CHARS, READ_FILE_MAX_LINE_LIMIT } from '../../src/shared/toolResultLimits'
import {
  READ_FILE_TAIL_CHUNK_BYTES,
  readFileRangeFromDisk,
  readFileTailFromDisk
} from './readFileStreaming'

describe('readFileStreaming bounded memory', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-read-stream-')))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function writeLargeLinesFile(name: string, lineCount: number, lineBody: string): Promise<string> {
    const abs = path.join(tmpDir, name)
    const fh = await fs.open(abs, 'w')
    try {
      const batch = 1000
      for (let i = 0; i < lineCount; i += batch) {
        const n = Math.min(batch, lineCount - i)
        let s = ''
        for (let j = 0; j < n; j++) s += `${lineBody}-${i + j}\n`
        await fh.write(Buffer.from(s))
      }
    } finally {
      await fh.close()
    }
    return abs
  }

  it('range without limit on large file returns content within char cap', async () => {
    // ~3MB，10 万行短行
    const abs = await writeLargeLinesFile('many-lines.log', 100_000, 'line-content-padding')
    expect((await fs.stat(abs)).size).toBeGreaterThan(READ_FILE_MAX_CHARS)

    const res = await readFileRangeFromDisk(abs, 1, undefined)
    expect(res.content.length).toBeLessThanOrEqual(READ_FILE_MAX_CHARS)
    expect(res.hasMore).toBe(true)
  })

  it('range without limit on large file caps lines at READ_FILE_MAX_LINE_LIMIT', async () => {
    const abs = await writeLargeLinesFile('cap-lines.log', 100_000, 'line-content-padding')

    const res = await readFileRangeFromDisk(abs, 1, undefined)
    const lineCount = res.content.split('\n').length
    expect(lineCount).toBeLessThanOrEqual(READ_FILE_MAX_LINE_LIMIT)
    expect(res.endLine).toBeLessThanOrEqual(READ_FILE_MAX_LINE_LIMIT)
    expect(res.hasMore).toBe(true)
  })

  it('range over a single oversized line returns truncated slice, not whole line', async () => {
    const abs = path.join(tmpDir, 'one-line.log')
    const fh = await fs.open(abs, 'w')
    try {
      const chunk = Buffer.alloc(512 * 1024, 0x62) // 'b'
      for (let i = 0; i < 6; i++) await fh.write(chunk) // 3MB 无换行
    } finally {
      await fh.close()
    }

    const res = await readFileRangeFromDisk(abs, 1, undefined)
    expect(res.content.length).toBeLessThanOrEqual(READ_FILE_MAX_CHARS)
    expect(res.truncated).toBe(true)
  }, 15_000)

  it('tail on large sparse-newline file returns bounded content without O(n^2) scan', async () => {
    const abs = path.join(tmpDir, 'sparse.log')
    const fh = await fs.open(abs, 'w')
    try {
      const chunk = Buffer.alloc(512 * 1024, 0x63) // 'c'，无换行
      for (let i = 0; i < 5; i++) await fh.write(chunk) // 2.5MB
    } finally {
      await fh.close()
    }

    const started = Date.now()
    const res = await readFileTailFromDisk(abs, 2, { chunkBytes: 4096 })
    const elapsed = Date.now() - started
    expect(res.content.length).toBeLessThanOrEqual(READ_FILE_MAX_CHARS)
    expect(res.hasMoreBefore).toBe(true)
    expect(res.truncated).toBe(true)
    expect(elapsed).toBeLessThan(5_000)
  }, 15_000)

  it('tail stops scanning once enough lines are found on large file', async () => {
    const abs = await writeLargeLinesFile('tail-happy.log', 100_000, 'line-content-padding')

    const res = await readFileTailFromDisk(abs, 10)
    expect(res.linesReturned).toBe(10)
    expect(res.hasMoreBefore).toBe(true)
    expect(res.content).toContain('line-content-padding-99999')
  })

  it('range on large CJK file does not introduce U+FFFD at chunk boundaries', async () => {
    const abs = path.join(tmpDir, 'cjk-range.log')
    const line = '中文日志行内容测试xxxxxxxxxxxxxxxxxxxx'
    const fh = await fs.open(abs, 'w')
    try {
      // 约 4 万行，>2MB，强制走流式 Range；每行含多字节 UTF-8
      for (let i = 0; i < 40_000; i++) {
        await fh.write(Buffer.from(`${line}-${i}\n`, 'utf8'))
      }
    } finally {
      await fh.close()
    }
    expect((await fs.stat(abs)).size).toBeGreaterThan(READ_FILE_MAX_CHARS)

    const res = await readFileRangeFromDisk(abs, 1, 2000)
    expect(res.content.includes('\uFFFD')).toBe(false)
    expect(res.content).toContain('中文日志行内容测试')
    expect(res.content).toContain('-0\n')
  }, 30_000)

  it('tail on large CJK file does not introduce U+FFFD', async () => {
    const abs = path.join(tmpDir, 'cjk-tail.log')
    const line = '中文日志行内容测试xxxxxxxxxxxxxxxxxxxx'
    const fh = await fs.open(abs, 'w')
    try {
      for (let i = 0; i < 40_000; i++) {
        await fh.write(Buffer.from(`${line}-${i}\n`, 'utf8'))
      }
    } finally {
      await fh.close()
    }

    const res = await readFileTailFromDisk(abs, 50)
    expect(res.content.includes('\uFFFD')).toBe(false)
    expect(res.content).toContain('中文日志行内容测试')
    expect(res.content).toContain('-39999')
    expect(res.linesReturned).toBe(50)
  }, 30_000)

  it('range preserves CRLF when first CR straddles chunk boundary', async () => {
    const abs = path.join(tmpDir, 'crlf-boundary.log')
    const fh = await fs.open(abs, 'w')
    try {
      // 首个 \r 恰好在第 64KiB 块末字节，\n 在下一块开头
      await fh.write(Buffer.alloc(READ_FILE_TAIL_CHUNK_BYTES - 1, 0x41)) // 'A' × 65535
      await fh.write(Buffer.from('\r\nSECOND_LINE\r\nTHIRD_LINE\r\n', 'utf8'))
      // 撑过 2MB 走流式路径
      const pad = Buffer.alloc(512 * 1024, 0x42)
      for (let i = 0; i < 5; i++) await fh.write(pad)
    } finally {
      await fh.close()
    }
    expect((await fs.stat(abs)).size).toBeGreaterThan(READ_FILE_MAX_CHARS)

    const firstTwo = await readFileRangeFromDisk(abs, 1, 2)
    expect(firstTwo.content.includes('\r\n')).toBe(true)
    expect(firstTwo.content.split(/\r\n|\n|\r/)).toEqual([
      'A'.repeat(READ_FILE_TAIL_CHUNK_BYTES - 1),
      'SECOND_LINE'
    ])
    expect(firstTwo.content).not.toMatch(/\r\n\r\n|\n\n/)
    expect(firstTwo.startLine).toBe(1)
    expect(firstTwo.endLine).toBe(2)

    const second = await readFileRangeFromDisk(abs, 2, 1)
    expect(second.content).toBe('SECOND_LINE')
    expect(second.startLine).toBe(2)
    expect(second.endLine).toBe(2)

    const third = await readFileRangeFromDisk(abs, 3, 1)
    expect(third.content).toBe('THIRD_LINE')
    expect(third.startLine).toBe(3)
    expect(third.endLine).toBe(3)
  }, 30_000)
})
