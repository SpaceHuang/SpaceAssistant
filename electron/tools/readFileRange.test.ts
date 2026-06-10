import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-read-range-'))
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
