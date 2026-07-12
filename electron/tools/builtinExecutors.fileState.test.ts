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

describe('edit/write fileStateCache', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    // macOS 上 os.tmpdir() 是 /private/var 的符号链接，realpath 化以匹配 resolveSafePathReal 的 cache key
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-file-state-')))
    cache = new FileStateCache()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('allows consecutive edits on the same file without re-read', async () => {
    const rel = 'sample.txt'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'alpha beta gamma', 'utf8')

    const ctx = makeCtx(tmpDir, cache)
    const read = await readFileExecutor.execute({ path: rel }, ctx)
    expect(read.success).toBe(true)

    const edit1 = await editFileExecutor.execute(
      { path: rel, old_string: 'alpha', new_string: 'ALPHA' },
      ctx
    )
    expect(edit1.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('ALPHA beta gamma')
    expect(cache.hasBeenRead(abs)).toBe(true)

    const edit2 = await editFileExecutor.execute(
      { path: rel, old_string: 'beta', new_string: 'BETA' },
      ctx
    )
    expect(edit2.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('ALPHA BETA gamma')
  })

  it('allows edit after write_file without re-read', async () => {
    const rel = 'new.txt'
    const abs = path.join(tmpDir, rel)
    const ctx = makeCtx(tmpDir, cache)

    const write = await writeFileExecutor.execute({ path: rel, content: 'hello world' }, ctx)
    expect(write.success).toBe(true)
    expect(cache.hasBeenRead(abs)).toBe(true)

    const edit = await editFileExecutor.execute(
      { path: rel, old_string: 'world', new_string: 'SpaceAssistant' },
      ctx
    )
    expect(edit.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('hello SpaceAssistant')
  })

  it('allows overwrite write after read, then edit without re-read', async () => {
    const rel = 'doc.md'
    const abs = path.join(tmpDir, rel)
    await fs.writeFile(abs, 'version one', 'utf8')

    const ctx = makeCtx(tmpDir, cache)
    expect((await readFileExecutor.execute({ path: rel }, ctx)).success).toBe(true)

    const write = await writeFileExecutor.execute({ path: rel, content: 'version two' }, ctx)
    expect(write.success).toBe(true)

    const edit = await editFileExecutor.execute(
      { path: rel, old_string: 'two', new_string: 'three' },
      ctx
    )
    expect(edit.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe('version three')
  })

  it('rejects edit when file was never read in session', async () => {
    const rel = 'unread.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'content', 'utf8')

    const ctx = makeCtx(tmpDir, cache)
    const edit = await editFileExecutor.execute(
      { path: rel, old_string: 'content', new_string: 'updated' },
      ctx
    )
    expect(edit.success).toBe(false)
    expect(edit.error).toBe('文件尚未在本会话中通过 read_file 读取，请先读取后再编辑')
  })

  it('rejects edit when path is missing', async () => {
    const ctx = makeCtx(tmpDir, cache)
    const edit = await editFileExecutor.execute(
      { old_string: 'a', new_string: 'b' },
      ctx
    )
    expect(edit.success).toBe(false)
    expect(edit.error).toBe('工具参数无效：edit_file 缺少必填参数 path')
  })

  it('rejects write when path is missing', async () => {
    const ctx = makeCtx(tmpDir, cache)
    const write = await writeFileExecutor.execute({ content: 'hello' }, ctx)
    expect(write.success).toBe(false)
    expect(write.error).toBe('工具参数无效：write_file 缺少必填参数 path')
  })
})
