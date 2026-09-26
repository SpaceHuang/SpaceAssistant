import fs from 'fs/promises'
import os from 'os'
import { spawn } from 'child_process'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

const ripgrep = vi.hoisted(() => ({
  inspect: vi.fn(),
  resolve: vi.fn()
}))

vi.mock('./ripgrepBinary', async (importActual) => {
  const actual = await importActual<typeof import('./ripgrepBinary')>()
  return {
    ...actual,
    inspectRipgrepBinary: ripgrep.inspect,
    resolveRipgrepBinary: ripgrep.resolve
  }
})

import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'
import { attachTestReadPermit } from './readPermitTestUtils'
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

async function permitDirectory(ctx: ToolExecutionContext, input: Record<string, unknown>, target: string): Promise<void> {
  const stat = await fs.stat(target)
  ctx.readExecutionPermit = buildReadExecutionPermit({
    requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'list_directory', input,
    facts: [{
      factId: `fact-${target}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: target,
      zone: 'workdir-normal', targetKind: 'directory', scope: 'direct-entries',
      identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
    }]
  })
}

describe('path field alias normalization', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-path-alias-')))
    cache = new FileStateCache()
    ripgrep.resolve.mockReturnValue({ path: '/usr/bin/true', source: 'development', platform: 'darwin', arch: 'arm64' })
    ripgrep.inspect.mockResolvedValue({ available: true })
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    ripgrep.resolve.mockReset()
    ripgrep.inspect.mockReset()
  })

  it('read_file accepts filePath', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'hello', 'utf8')
    const input = { filePath: rel }
    const ctx = makeCtx(tmpDir, cache)
    await attachTestReadPermit('read_file', input, ctx)
    const res = await readFileExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    expect(String(res.data?.content)).toBe('hello')
  })

  it('read_file accepts file_path', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'world', 'utf8')
    const input = { file_path: rel }
    const ctx = makeCtx(tmpDir, cache)
    await attachTestReadPermit('read_file', input, ctx)
    const res = await readFileExecutor.execute(input, ctx)
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
    await attachTestReadPermit('read_file', { filePath: rel }, ctx)
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
    const input = { filePath: '.' }
    const ctx = makeCtx(tmpDir, cache)
    await permitDirectory(ctx, input, tmpDir)
    const res = await listDirectoryExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
  })

  it('list_directory with no path-like field defaults to workDir root', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'x', 'utf8')
    const input = {}
    const ctx = makeCtx(tmpDir, cache)
    await permitDirectory(ctx, input, tmpDir)
    const res = await listDirectoryExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    // 默认 '.' -> 列工作目录根，应能看到刚写入的 a.txt（data 形如 { entries: [{ name, ... }] }）
    expect(JSON.stringify(res.data)).toMatch(/a\.txt/)
  })

  it('未携带目录 permit 时，在调用 opendir 前拒绝', async () => {
    const opendir = vi.spyOn(fs, 'opendir')
    try {
      const res = await listDirectoryExecutor.execute({ path: '.' }, makeCtx(tmpDir, cache))
      expect(res).toMatchObject({ success: false, diagnostic: { caseId: 'read-permit-missing' } })
      expect(opendir).not.toHaveBeenCalled()
    } finally {
      opendir.mockRestore()
    }
  })

  it('目录枚举仅返回前 500 项并标记截断', async () => {
    const input = { path: '.' }
    const ctx = makeCtx(tmpDir, cache)
    await Promise.all(Array.from({ length: 501 }, (_, index) => fs.writeFile(path.join(tmpDir, `entry-${String(index).padStart(3, '0')}`), '')))
    await permitDirectory(ctx, input, tmpDir)
    const result = await listDirectoryExecutor.execute(input, ctx)
    expect(result).toMatchObject({ success: true, data: { entries: expect.any(Array), truncated: true, limit: 500 } })
    expect((result.data as { entries: unknown[] }).entries).toHaveLength(500)
  })

  it('grep accepts file_path', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'needle here', 'utf8')
    // ripgrep mock 二进制（/usr/bin/true）在 Windows 上不存在，经 ctx 测试缝注入
    // 跨平台 node fixture 顶替 rg 进程（fixture 产出 rg 风格命中文本后正常退出）。
    const fixture = path.join(tmpDir, 'rg-alias-fixture.cjs')
    await fs.writeFile(
      fixture,
      `const a = process.argv.slice(2)\nconst file = a[a.length - 1]\nif (a[a.indexOf('--regexp') + 1] === 'needle') process.stdout.write(file + ':1:needle here\\n')\n`,
      'utf8'
    )
    const input = { pattern: 'needle', file_path: 'a.txt' }
    const ctx = {
      ...makeCtx(tmpDir, cache),
      grepSpawnProcess: (_binary, rgArgs, options) => spawn(process.execPath, [fixture, ...rgArgs], options)
    }
    await attachTestReadPermit('grep', input, ctx)
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
  })

  it('grep 的生产执行必须消费 permit 并按许可目标搜索', async () => {
    const file = path.join(tmpDir, 'permitted.txt')
    await fs.writeFile(file, 'needle here', 'utf8')
    const fixture = path.join(tmpDir, 'rg-permit-fixture.cjs')
    await fs.writeFile(fixture, `const a=process.argv.slice(2); const f=a[a.length-1]; process.stdout.write(f+':1:needle here\n')`)
    const ctx = { ...makeCtx(tmpDir, cache), lane: 'desktop' as const, grepSpawnProcess: (_binary: string, args: string[], options: never) => spawn(process.execPath, [fixture, ...args], options) }
    const denied = await grepExecutor.execute({ pattern: 'needle', path: file }, ctx)
    expect(denied).toMatchObject({ success: false, diagnostic: { caseId: 'read-permit-missing' } })
    const stat = await fs.stat(file)
    ctx.readExecutionPermit = buildReadExecutionPermit({ requestId: ctx.requestId!, toolUseId: ctx.toolUseId!, toolName: 'grep', input: { pattern: 'needle', path: file }, facts: [{ factId: 'grep-fact', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'file', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs } }] })
    const allowed = await grepExecutor.execute({ pattern: 'needle', path: file }, ctx)
    expect(allowed.success).toBe(true)
    const changedPermit = buildReadExecutionPermit({ requestId: ctx.requestId!, toolUseId: ctx.toolUseId!, toolName: 'grep', input: { pattern: 'needle', path: file }, facts: [{ factId: 'original-grep-fact', decisionRuleId: 'read-group-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'file', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size + 1, mtimeMs: stat.mtimeMs } }] })
    ctx.readExecutionPermit = changedPermit
    const veto = await grepExecutor.execute({ pattern: 'needle', path: file }, ctx)
    expect(veto).toMatchObject({ success: false, diagnostic: { caseId: 'read-target-identity-changed', factId: 'original-grep-fact' } })
  })

  it.each(['wechat', 'feishu', 'automation'] as const)('%s lane grep 缺 permit 时不启动 ripgrep', async (lane) => {
    const file = path.join(tmpDir, 'remote.txt')
    await fs.writeFile(file, 'needle')
    const spawnProcess = vi.fn()
    const result = await grepExecutor.execute({ pattern: 'needle', path: file }, {
      ...makeCtx(tmpDir, cache), lane, grepSpawnProcess: spawnProcess as never
    })
    expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-permit-missing', category: 'integration-violation' } })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('开发态 staging 缺失时明确失败，不返回假阴性或 degraded 结果', async () => {
    ripgrep.resolve.mockReturnValue({ path: '/missing/rg', source: 'development', platform: 'darwin', arch: 'arm64' })
    ripgrep.inspect.mockResolvedValue({ available: false, reason: 'not_found' })
    const diagnostic = vi.fn()
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'needle')
    const input = { pattern: 'needle', path: 'a.txt' }
    const ctx = { ...makeCtx(tmpDir, cache), recordDiagnostic: diagnostic }
    await attachTestReadPermit('grep', input, ctx)

    const res = await grepExecutor.execute(input, ctx)

    expect(res).toMatchObject({ success: false })
    expect(res.error).toContain('npm run prepare:rg -- --target=darwin-arm64')
    expect(JSON.stringify(res.data ?? {})).not.toContain('No matches found')
    expect(JSON.stringify(res.data ?? {})).not.toContain('degraded')
    expect(diagnostic).toHaveBeenCalledWith({
      code: 'grep-ripgrep-unavailable',
      message: 'source=development;platform=darwin;arch=arm64;status=unavailable;reason=not_found'
    })
  })

  it('打包态内置 rg 不可用时返回安装完整性错误而非 fallback', async () => {
    ripgrep.resolve.mockReturnValue({ path: '/missing/rg', source: 'bundled', platform: 'darwin', arch: 'arm64' })
    ripgrep.inspect.mockResolvedValue({ available: false, reason: 'not_found' })
    const diagnostic = vi.fn()
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'needle')
    const input = { pattern: 'needle', path: 'a.txt' }
    const ctx = { ...makeCtx(tmpDir, cache), recordDiagnostic: diagnostic }
    await attachTestReadPermit('grep', input, ctx)

    const res = await grepExecutor.execute(input, ctx)

    expect(res).toMatchObject({ success: false, error: '内置 ripgrep 不可用（not_found）。请重新安装应用后重试。' })
    expect(JSON.stringify(res.data ?? {})).not.toContain('degraded')
    expect(diagnostic).toHaveBeenCalledWith({
      code: 'grep-ripgrep-unavailable',
      message: 'source=bundled;platform=darwin;arch=arm64;status=unavailable;reason=not_found'
    })
  })

  // -- 回归：原 path 字段仍可用 --
  it('read_file still works with canonical path', async () => {
    const rel = 'a.txt'
    await fs.writeFile(path.join(tmpDir, rel), 'ok', 'utf8')
    const input = { path: rel }
    const ctx = makeCtx(tmpDir, cache)
    await attachTestReadPermit('read_file', input, ctx)
    const res = await readFileExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
  })
})
