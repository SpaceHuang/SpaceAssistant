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
import type { ToolExecutionContext } from './types'
import { grepExecutor } from './builtinExecutors'

describe('I1/I2：searchScope 序列化形态（§7.11 子项 3，AC-44）', () => {
  let tmpDir: string
  let cache: FileStateCache

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-scope-ser-')))
    cache = new FileStateCache()
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    ripgrep.resolve.mockReset()
    ripgrep.inspect.mockReset()
  })

  const makeCtx = (): ToolExecutionContext => ({
    workDir: tmpDir,
    userDataDir: path.join(tmpDir, '.userdata'),
    requestId: 'req-scope-ser',
    toolUseId: 'tool-scope-ser',
    sessionId: 'session-scope-ser',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: cache,
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false }
  })

  const attachDirPermit = async (ctx: ToolExecutionContext, input: Record<string, unknown>): Promise<void> => {
    const stat = await fs.stat(tmpDir)
    ctx.readExecutionPermit = buildReadExecutionPermit({
      requestId: ctx.requestId!, toolUseId: ctx.toolUseId!, toolName: 'grep', input,
      facts: [{ factId: `fact-${tmpDir}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: tmpDir, zone: 'workdir-normal', targetKind: 'directory', scope: 'subtree', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs } }]
    })
  }

  const attachFilePermit = async (ctx: ToolExecutionContext, input: Record<string, unknown>, file: string): Promise<void> => {
    const stat = await fs.stat(file)
    ctx.readExecutionPermit = buildReadExecutionPermit({
      requestId: ctx.requestId!, toolUseId: ctx.toolUseId!, toolName: 'grep', input,
      facts: [{ factId: `fact-${file}`, decisionRuleId: 'read-target-workdir-allow', normalizedPath: file, zone: 'workdir-normal', targetKind: 'file', identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs } }]
    })
  }

  const writeFixture = async (body: string): Promise<string> => {
    const fixture = path.join(tmpDir, 'rg-scope-ser-fixture.cjs')
    await fs.writeFile(fixture, body, 'utf8')
    return fixture
  }

  /** 强制走 rg 路径（resolve 假二进制 + inspect 可用；spawn 由 grepSpawnProcess 顶替为 node fixture） */
  const mockRgAvailable = (): void => {
    ripgrep.resolve.mockReturnValue({ path: '/usr/bin/true', source: 'development', platform: process.platform, arch: process.arch })
    ripgrep.inspect.mockResolvedValue({ available: true })
  }

  it('rg 成功：searchScope 不含 engine/truncated/skippedCount（常态默认值省略）', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'needle here\n')
    const fixture = await writeFixture(`const a = process.argv.slice(2)\nconst f = a[a.length - 1]\nif (a[a.indexOf('--regexp') + 1] === 'needle') process.stdout.write(f + ':1:needle here\\n')\n`)
    mockRgAvailable()
    const ctx = makeCtx()
    ctx.grepSpawnProcess = ((_binary: string, args: string[], options: never) => spawn(process.execPath, [fixture, ...args], options)) as never
    const input = { pattern: 'needle', path: '.' }
    await attachDirPermit(ctx, input)
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    const scope = (res.data as { searchScope: Record<string, unknown> }).searchScope
    expect(scope).toBeDefined()
    expect(scope).not.toHaveProperty('engine')
    expect(scope).not.toHaveProperty('truncated')
    expect(scope).not.toHaveProperty('skippedCount')
    expect(scope).toHaveProperty('root')
    expect(scope).toHaveProperty('skipped')
  })

  it('rg no_match：searchScope 同规则省略常态字段（AC-44 no_match 同规则）', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'nothing relevant\n')
    const fixture = await writeFixture(`process.exit(1)\n`)
    mockRgAvailable()
    const ctx = makeCtx()
    ctx.grepSpawnProcess = ((_binary: string, args: string[], options: never) => spawn(process.execPath, [fixture, ...args], options)) as never
    const input = { pattern: 'needle', path: '.' }
    await attachDirPermit(ctx, input)
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    expect((res.data as { status?: string }).status).toBe('no_match')
    const scope = (res.data as { searchScope: Record<string, unknown> }).searchScope
    expect(scope).not.toHaveProperty('engine')
    expect(scope).not.toHaveProperty('truncated')
    expect(scope).not.toHaveProperty('skippedCount')
  })

  it('walk 降级：searchScope 含 engine: walk（非常态值保留）', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'needle here\n')
    ripgrep.resolve.mockReturnValue({ path: undefined, reason: 'unsupported', source: 'none', platform: process.platform, arch: process.arch })
    const ctx = makeCtx()
    const input = { pattern: 'needle', path: '.' }
    await attachDirPermit(ctx, input)
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    const scope = (res.data as { searchScope: Record<string, unknown> }).searchScope
    expect(scope).toMatchObject({ engine: 'walk' })
    expect(scope).not.toHaveProperty('skippedCount')
  })

  it('walk 降级 + head_limit 截断：searchScope 含 truncated: true 与 limitReason（非常态值保留）', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'needle one\nneedle two\n')
    ripgrep.resolve.mockReturnValue({ path: undefined, reason: 'unsupported', source: 'none', platform: process.platform, arch: process.arch })
    const ctx = makeCtx()
    const input = { pattern: 'needle', path: 'a.txt', output_mode: 'content', head_limit: 1 }
    await attachFilePermit(ctx, input, path.join(tmpDir, 'a.txt'))
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    const scope = (res.data as { searchScope: Record<string, unknown> }).searchScope
    expect(scope).toMatchObject({ truncated: true, limitReason: 'head_limit' })
    expect(scope).not.toHaveProperty('skippedCount')
  })
})
