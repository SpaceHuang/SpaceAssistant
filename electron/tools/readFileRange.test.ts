import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { READ_FILE_MAX_CHARS } from '../../src/shared/toolResultLimits'
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'
import { attachTestReadPermit } from './readPermitTestUtils'
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

async function executePermittedRead(input: Record<string, unknown>, ctx: ToolExecutionContext) {
  await attachTestReadPermit('read_file', input, ctx)
  return readFileExecutor.execute(input, ctx)
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

  it('生产形态无 permit 时 fail closed，带 permit 时从许可目标读取', async () => {
    const file = path.join(tmpDir, 'permit.txt')
    await fs.writeFile(file, 'permit content')
    const ctx = { ...makeCtx(tmpDir, cache), lane: 'desktop' as const }
    const denied = await readFileExecutor.execute({ path: file }, ctx)
    expect(denied).toMatchObject({ success: false, diagnostic: { caseId: 'read-permit-missing', category: 'integration-violation' } })
    const stat = await fs.stat(file)
    ctx.readExecutionPermit = buildReadExecutionPermit({ requestId: ctx.requestId!, toolUseId: ctx.toolUseId!, toolName: 'read_file', input: { path: file }, facts: [{ factId: 'fact-permit', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'file', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs } }] })
    const allowed = await readFileExecutor.execute({ path: file }, ctx)
    expect(allowed).toMatchObject({ success: true, data: { content: 'permit content' } })
  })

  it.each(['wechat', 'feishu', 'automation'] as const)('%s lane 缺 permit 时不走旧路径读取分支', async (lane) => {
    const file = path.join(tmpDir, `${lane}.txt`)
    await fs.writeFile(file, 'must not be read')
    const open = vi.spyOn(fs, 'open')
    try {
      const result = await readFileExecutor.execute({ path: file }, { ...makeCtx(tmpDir, cache), lane })
      expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-permit-missing' } })
      expect(open).not.toHaveBeenCalled()
    } finally { open.mockRestore() }
  })

  it('returns only requested line window', async () => {
    const rel = 'doc.md'
    await fs.writeFile(path.join(tmpDir, rel), 'a\nb\nc\nd\ne', 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const res = await executePermittedRead({ path: rel, offset: 2, limit: 2 }, ctx)
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

  it('missing permit blocks a directory target before executor reads it', async () => {
    const rel = 'subdir'
    await fs.mkdir(path.join(tmpDir, rel))
    const ctx = makeCtx(tmpDir, cache)

    const res = await readFileExecutor.execute({ path: rel }, ctx)
    expect(res.success).toBe(false)
    expect(res.diagnostic).toMatchObject({ caseId: 'read-permit-missing' })
  })

  it('returns full file when range params omitted', async () => {
    const rel = 'small.txt'
    const body = 'hello'
    await fs.writeFile(path.join(tmpDir, rel), body, 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const res = await executePermittedRead({ path: rel }, ctx)
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ content: body, encoding: 'utf8' })
    expect(res.data).not.toHaveProperty('totalLines')
  })

  it('does not overwrite fileStateCache on range read after full read', async () => {
    const rel = 'doc.md'
    const body = 'a\nb\nc\nd\ne'
    await fs.writeFile(path.join(tmpDir, rel), body, 'utf8')
    const ctx = makeCtx(tmpDir, cache)

    const full = await executePermittedRead({ path: rel }, ctx)
    expect(full.success).toBe(true)

    const partial = await executePermittedRead({ path: rel, offset: 2, limit: 2 }, ctx)
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

    const read = await executePermittedRead({ path: rel, offset: 2, limit: 1 }, ctx)
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

    const read = await executePermittedRead({ path: rel, offset: 1, limit: 3 }, ctx)
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

describe('read_file permit diagnostics', () => {
  it('identity veto returns the original factId in its structured diagnostic', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-read-fact-diagnostic-'))
    try {
      const file = path.join(dir, 'target.txt')
      await fs.writeFile(file, 'x')
      const stat = await fs.stat(file)
      const input = { path: file }
      const permit = buildReadExecutionPermit({
        requestId: 'req-test', toolUseId: 'tool-test', toolName: 'read_file', input,
        facts: [{ factId: 'original-read-fact', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'outside-workdir', targetKind: 'file', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size + 1, mtimeMs: stat.mtimeMs } }]
      })
      const ctx = { ...makeCtx(dir, new FileStateCache()), lane: 'desktop', readExecutionPermit: permit }
      const result = await readFileExecutor.execute(input, ctx)
      expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-target-identity-changed', factId: 'original-read-fact' } })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('missing permitted target returns an environment diagnostic with its factId', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-read-missing-diagnostic-'))
    try {
      const file = path.join(dir, 'missing.txt')
      const input = { path: file }
      const permit = buildReadExecutionPermit({ requestId: 'req-test', toolUseId: 'tool-test', toolName: 'read_file', input, facts: [{ factId: 'missing-read-fact', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'missing' }] })
      const ctx = { ...makeCtx(dir, new FileStateCache()), lane: 'desktop', readExecutionPermit: permit }
      const result = await readFileExecutor.execute(input, ctx)
      expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-target-missing', category: 'environment', factId: 'missing-read-fact' } })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
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

    const res = await executePermittedRead({ path: rel, tail: 3 }, ctx)
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

    const res = await executePermittedRead({ path: rel, tail: 50 }, ctx)
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

    const res = await executePermittedRead({ path: rel, tail: 2 }, ctx)
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

    const res = await executePermittedRead({ path: rel }, ctx)
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
    const res = await executePermittedRead({ path: rel, offset: 2, limit: 1 }, ctx)
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

    const res = await executePermittedRead({ path: rel, tail: 3 }, ctx)
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
    const res = await executePermittedRead({ path: rel, tail: 50 }, ctx)
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

    await executePermittedRead({ path: rel }, ctx)
    await executePermittedRead({ path: rel, tail: 2 }, ctx)

    const abs = path.join(tmpDir, rel)
    expect(cache.get(abs)?.content).toBe(body)
    expect(cache.get(abs)?.isRangeView).toBeFalsy()
  })

  it('读取已许可的工作目录外目标时真实 read_file 执行器从 permit 句柄读取', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-read-permit-workspace-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-read-permit-outside-'))
    try {
      const file = path.join(outside, 'approved.txt')
      await fs.writeFile(file, 'approved outside content')
      const stat = await fs.stat(file)
      const input = { path: file }
      const permit = buildReadExecutionPermit({
        requestId: 'req-test', toolUseId: 'tool-test', toolName: 'read_file', input,
        facts: [{ factId: 'outside-read-fact', decisionRuleId: 'read-group-outside-allow', normalizedPath: file, zone: 'outside-workdir', targetKind: 'file', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs } }]
      })
      const ctx = { ...makeCtx(workspace, new FileStateCache()), lane: 'desktop', readExecutionPermit: permit }
      const result = await readFileExecutor.execute(input, ctx)
      expect(result).toMatchObject({ success: true, data: { content: 'approved outside content' } })
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
