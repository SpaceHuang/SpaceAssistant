import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import {
  editFileExecutor,
  grepExecutor,
  listDirectoryExecutor,
  readFileExecutor,
  writeFileExecutor
} from './builtinExecutors'

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

describe('path field alias normalization', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-path-alias-')))
    cache = new FileStateCache()
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('read_file accepts filePath', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'hello', 'utf8')
    const res = await readFileExecutor.execute({ filePath: rel }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
    expect(String(res.data?.content)).toBe('hello')
  })

  it('read_file accepts file_path', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'world', 'utf8')
    const res = await readFileExecutor.execute({ file_path: rel }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
    expect(String(res.data?.content)).toBe('world')
  })

  it('read_file with no path-like field returns clear missing-path error (not “路径是目录而非文件: ”)', async () => {
    const res = await readFileExecutor.execute({}, makeCtx(tmpDir, cache))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/缺少必填参数 path/)
    expect(res.error).toMatch(/请勿使用 filePath 或 file_path/)
    expect(res.error).not.toMatch(/路径是目录而非文件/)
  })

  it('edit_file accepts filePath', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'alpha beta', 'utf8')
    const ctx = makeCtx(tmpDir, cache)
    // edit_file 要求先在本会话通过 read_file 读取过该文件
    await readFileExecutor.execute({ filePath: rel }, ctx)
    const res = await editFileExecutor.execute(
      { filePath: rel, old_string: 'alpha', new_string: 'ALPHA' },
      ctx
    )
    expect(res.success).toBe(true)
    expect(await fs.readFile(path.join(tmpDir, rel), 'utf8')).toBe('ALPHA beta')
  })

  it('edit_file with no path-like field returns hinted missing-path error', async () => {
    const res = await editFileExecutor.execute(
      { old_string: 'a', new_string: 'b' },
      makeCtx(tmpDir, cache)
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/缺少必填参数 path/)
    expect(res.error).toMatch(/请勿使用 filePath 或 file_path/)
  })

  it('write_file accepts file_path', async () => {
    const rel = 'out.txt'
    const res = await writeFileExecutor.execute(
      { file_path: rel, content: 'hi' },
      makeCtx(tmpDir, cache)
    )
    expect(res.success).toBe(true)
    expect(await fs.readFile(path.join(tmpDir, rel), 'utf8')).toBe('hi')
  })

  it('write_file with no path-like field returns hinted missing-path error', async () => {
    const res = await writeFileExecutor.execute({ content: 'hi' }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/缺少必填参数 path.*请勿使用 filePath 或 file_path/)
  })

  it('list_directory accepts filePath', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'x', 'utf8')
    const res = await listDirectoryExecutor.execute({ filePath: '.' }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
  })

  it('list_directory with no path-like field defaults to workDir root', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'x', 'utf8')
    const res = await listDirectoryExecutor.execute({}, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
    // 默认 '.' -> 列工作目录根，应能看到刚写入的 a.txt（data 形如 { entries: [{ name, ... }] }）
    expect(JSON.stringify(res.data)).toMatch(/a\.txt/)
  })

  it('grep accepts file_path', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'needle here', 'utf8')
    const res = await grepExecutor.execute(
      { pattern: 'needle', file_path: '.' },
      makeCtx(tmpDir, cache)
    )
    expect(res.success).toBe(true)
  })

  // -- 回归：原 path 字段仍可用 --
  it('read_file still works with canonical path', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'ok', 'utf8')
    const res = await readFileExecutor.execute({ path: rel }, makeCtx(tmpDir, cache))
    expect(res.success).toBe(true)
  })
})
