import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { READ_FILE_MAX_CHARS } from '../../src/shared/toolResultLimits'
import type { ToolExecutionContext } from './types'
import { editFileExecutor, readFileExecutor, writeFileExecutor } from './builtinExecutors'

function makeCtx(workDir: string, cache: FileStateCache): ToolExecutionContext {
  return {
    workDir,
    userDataDir: path.join(workDir, '.userdata'),
    requestId: 'req-test',
    toolUseId: 'tool-test',
    sessionId: 'session-test',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: cache,
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false }
  }
}

describe('read_file offset/limit', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    // macOS 上 os.tmpdir() 是 /private/var 的符号链接，realpath 化以匹配 resolveSafePathReal 的 cache key
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-read-range-')))
    cache = new FileStateCache()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns only requested line window', async () => {
    const rel = 'doc.md'
    await fs.writeFile(path.join(tmpDir, rel), 'a\nb\nc\nd\ne', 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel, offset: 2, limit: 2 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({
      path: rel,
      content: 'b\nc',
      totalLines: 5,
      startLine: 2,
      endLine: 3,
      hasMore: true
    })
  })

  it('rejects directory path with actionable error', async () => {
    const rel = 'subdir'
    await fs.mkdir(path.join(tmpDir, rel))
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/目录/)
    expect(res.error).toMatch(/list_directory/)
  })

  it('returns full file when range params omitted', async () => {
    const rel = 'small.txt'
    const body = 'hello'
    await fs.writeFile(path.join(tmpDir, rel), body, 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ content: body, encoding: 'utf8' })
    expect(res.data).not.toHaveProperty('totalLines')
  })

  it('does not overwrite fileStateCache on range read after full read', async () => {
    const rel = 'doc.md'
    const body = 'a\nb\nc\nd\ne'
    await fs.writeFile(path.join(tmpDir, rel), body, 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const full = await readFileExecutor.execute({ path: rel }, ctx)
    expect(full.success).toBe(true)

    const partial = await readFileExecutor.execute({ path: rel, offset: 2, limit: 2 }, ctx)
    expect(partial.success).toBe(true)
    expect(partial.data?.content).toBe('b\nc')

    const abs = path.join(tmpDir, rel)
    expect(cache.get(abs)?.content).toBe(body)
    expect(cache.get(abs)?.isPartial).toBe(false)
    expect(cache.get(abs)?.isRangeView).toBeFalsy()
  })

  it('allows edit after range-only read', async () => {
    const rel = 'doc.md'
    const body = 'alpha\nbeta\ngamma\n'
    await fs.writeFile(path.join(tmpDir, rel), body, 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const read = await readFileExecutor.execute({ path: rel, offset: 2, limit: 1 }, ctx)
    expect(read.success).toBe(true)
    expect(cache.hasBeenRead(path.join(tmpDir, rel))).toBe(true)
    expect(cache.get(path.join(tmpDir, rel))?.isRangeView).toBe(true)

    const edit = await editFileExecutor.execute(
      { path: rel, old_string: 'beta', new_string: 'BETA' },
      ctx
    )
    expect(edit.success).toBe(true)
    expect(await fs.readFile(path.join(tmpDir, rel), 'utf8')).toBe('alpha\nBETA\ngamma\n')
  })

  it('edit matches LF old_string against CRLF file after range read', async () => {
    const rel = 'crlf.md'
    const body = '## Title\r\n\r\n### Sub\r\n\r\nbody'
    await fs.writeFile(path.join(tmpDir, rel), body, 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const read = await readFileExecutor.execute({ path: rel, offset: 1, limit: 3 }, ctx)
    expect(read.success).toBe(true)
    expect(read.data?.content).toContain('\r\n')

    const edit = await editFileExecutor.execute(
      {
        path: rel,
        old_string: '## Title\n\n### Sub',
        new_string: '## Title\n\n> note\n\n### Sub'
      },
      ctx
    )
    expect(edit.success).toBe(true)
    const out = await fs.readFile(path.join(tmpDir, rel), 'utf8')
    expect(out).toContain('> note')
    expect(out.includes('\r\n')).toBe(true)
  })
})

describe('read_file tail / meta / large range', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-read-tail-')))
    cache = new FileStateCache()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('A1: small file tail returns last lines in order', async () => {
    const rel = 'log.txt'
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
    await fs.writeFile(path.join(tmpDir, rel), lines.join('\n'), 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel, tail: 3 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({
      content: 'line8\nline9\nline10',
      linesReturned: 3,
      hasMoreBefore: true,
      encoding: 'utf8'
    })
  })

  it('A2: tail larger than file returns all lines', async () => {
    const rel = 'short.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'a\nb\nc', 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel, tail: 50 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({
      content: 'a\nb\nc',
      linesReturned: 3,
      hasMoreBefore: false
    })
  })

  it('A11: CRLF file tail preserves line endings', async () => {
    const rel = 'crlf.log'
    await fs.writeFile(path.join(tmpDir, rel), 'a\r\nb\r\nc\r\nd', 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel, tail: 2 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data?.content).toBe('c\r\nd')
    expect(res.data?.linesReturned).toBe(2)
  })

  it('A8: oversized file without range returns meta only', async () => {
    const rel = 'big.bin.txt'
    const size = READ_FILE_MAX_CHARS + 1024
    const fh = await fs.open(path.join(tmpDir, rel), 'w')
    try {
      await fh.write(Buffer.alloc(size, 0x61)) // 'a'
    } finally {
      await fh.close()
    }
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({
      path: rel,
      content: '',
      encoding: 'utf8',
      exceedsReadLimit: true,
      maxChars: READ_FILE_MAX_CHARS,
      byteSize: size
    })
    expect(String(res.data?.note ?? '')).toMatch(/tail|offset/i)
    expect(String(res.data?.content ?? '').length).toBe(0)
  })

  it('A9: large file range can read past the first 2MB prefix', async () => {
    const rel = 'huge.txt'
    const prefix = 'P'.repeat(READ_FILE_MAX_CHARS + 100)
    const marker = '\nUNIQUE_MARKER_LINE\n'
    await fs.writeFile(path.join(tmpDir, rel), prefix + marker + 'tail', 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    // Count lines in prefix+marker roughly: one huge line then UNIQUE then tail
    const res = await readFileExecutor.execute({ path: rel, offset: 2, limit: 1 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data?.content).toContain('UNIQUE_MARKER_LINE')
    expect(res.data?.startLine).toBe(2)
    expect(res.data).not.toHaveProperty('totalLines')
  })

  it('A10: tail window over char limit is truncated with hasMoreBefore', async () => {
    const rel = 'fat-lines.txt'
    const line = 'L'.repeat(Math.floor(READ_FILE_MAX_CHARS / 2) + 10)
    await fs.writeFile(path.join(tmpDir, rel), `${line}\n${line}\n${line}`, 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel, tail: 3 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data?.truncated).toBe(true)
    expect(res.data?.hasMoreBefore).toBe(true)
    const content = String(res.data?.content ?? '')
    expect(content.length).toBeLessThanOrEqual(READ_FILE_MAX_CHARS)
    // linesReturned 须与截断后实际返回行数一致（§4.3.2）
    expect(res.data?.linesReturned).toBe(content.split('\n').length)
  })

  it('A7: large file tail does not call fs.readFile for whole file', async () => {
    const rel = 'chunked.log'
    const abs = path.join(tmpDir, rel)
    // Build >2MB file with trailing numbered lines so tail is verifiable
    const fh = await fs.open(abs, 'w')
    try {
      const chunk = Buffer.alloc(256 * 1024, 0x61) // 'a'
      for (let i = 0; i < 9; i++) await fh.write(chunk) // ~2.25MB of 'a'
      await fh.write(Buffer.from('\n'))
      for (let i = 1; i <= 60; i++) {
        await fh.write(Buffer.from(`end-line-${i}\n`))
      }
    } finally {
      await fh.close()
    }
    expect((await fs.stat(abs)).size).toBeGreaterThan(READ_FILE_MAX_CHARS)

    const readFileSpy = vi.spyOn(fs, 'readFile')
    const ctx = makeCtx(tmpDir, cache)
    const res = await readFileExecutor.execute({ path: rel, tail: 50 }, ctx)
    expect(res.success).toBe(true)
    expect(res.data?.linesReturned).toBe(50)
    expect(String(res.data?.content ?? '')).toContain('end-line-60')
    expect(String(res.data?.content ?? '')).not.toContain('end-line-1\n')
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  it('does not overwrite full cache on tail read', async () => {
    const rel = 'cached.txt'
    const body = 'a\nb\nc\nd\ne'
    await fs.writeFile(path.join(tmpDir, rel), body, 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    await readFileExecutor.execute({ path: rel }, ctx)
    await readFileExecutor.execute({ path: rel, tail: 2 }, ctx)

    const abs = path.join(tmpDir, rel)
    expect(cache.get(abs)?.content).toBe(body)
    expect(cache.get(abs)?.isRangeView).toBeFalsy()
  })
})
