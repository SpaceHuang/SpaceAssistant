import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

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
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'
import type { ToolExecutionContext } from './types'
import {
  grepExecutor,
  grepFallbackJs,
  resolveGrepEngine,
  type GrepExecArgs
} from './builtinExecutors'
import type { RipgrepUnavailableReason } from './ripgrepBinary'

const baseArgs = (overrides: Partial<GrepExecArgs> = {}): GrepExecArgs => ({
  outputMode: 'files_with_matches',
  ignoreCase: false,
  showLineNumber: true,
  multiline: false,
  headLimit: 100,
  includeIgnored: false,
  ...overrides
})

async function makeTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-fallback-'))
  await fs.writeFile(path.join(root, 'a.txt'), 'Needle in a\n', 'utf8')
  await fs.writeFile(path.join(root, 'b.txt'), 'Needle in b\n', 'utf8')
  return root
}

// Windows:fixture/文件句柄释放是异步的,rm 容忍短暂 EBUSY
async function rmRoot(root: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    try {
      await fs.rm(root, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

describe('grepFallbackJs 边界上报(方案 §3.2 六处改造)', () => {
  it('T-B1:超过 2 MiB 上限的文件计入 skippedFiles 并在摘要可见,不得静默漏报', async () => {
    const root = await makeTree()
    const big = Buffer.alloc(3 * 1024 * 1024 + 16)
    big.write('Needle', 1024)
    await fs.writeFile(path.join(root, 'big.txt'), big)
    const res = await grepFallbackJs(root, root, 'Needle', baseArgs(), new AbortController().signal, () => {}, 60_000)
    expect(res.partial).toBe(true)
    expect(res.skippedFiles).toHaveLength(1)
    expect(res.skippedFiles[0]).toMatchObject({ path: 'big.txt', reason: 'too_large' })
    expect(res.skippedFiles[0]!.bytes).toBeGreaterThan(2 * 1024 * 1024)
    // 摘要必须可见(不得只回 No matches found)
    expect(res.boundarySummary).toContain('跳过')
    expect(res.boundarySummary).toContain('big.txt')
    await rmRoot(root)
  })

  it('T-B2:读失败必须计数并聚合上报(评审 B3 的闸)', async () => {
    const root = await makeTree()
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' })
    })
    const res = await grepFallbackJs(root, root, 'Needle', baseArgs(), new AbortController().signal, () => {}, 60_000, { readFile })
    expect(res.partial).toBe(true)
    expect(res.readErrors[0]).toMatchObject({ reason: 'read_error', count: 2 })
    expect(res.readErrors[0]!.sampledPaths).toContain('a.txt')
    expect(res.boundarySummary).toContain('读取失败')
    await rmRoot(root)
  })

  it('T-B3:先 stat 后读——超限文件不被 readFile(防「调上限不调时机」回归)', async () => {
    const root = await makeTree()
    await fs.writeFile(path.join(root, 'big.bin'), Buffer.alloc(5 * 1024 * 1024))
    const readFile = vi.fn((p: string, opts?: { signal?: AbortSignal }) => fs.readFile(p, opts))
    const res = await grepFallbackJs(root, root, 'Needle', baseArgs(), new AbortController().signal, () => {}, 60_000, { readFile })
    expect(res.skippedFiles).toHaveLength(1)
    expect(res.skippedFiles[0]).toMatchObject({ path: 'big.bin', reason: 'too_large' })
    expect(readFile.mock.calls.filter(([p]) => String(p).endsWith('big.bin'))).toHaveLength(0)
    await rmRoot(root)
  })

  it('T-B4:中止响应——readFile 收到 signal;abort 后经 await 边界即时停止', async () => {
    const root = await makeTree()
    const controller = new AbortController()
    const seenSignals: Array<AbortSignal | undefined> = []
    const readFile = vi.fn((p: string, opts?: { signal?: AbortSignal }) => {
      seenSignals.push(opts?.signal)
      if (!controller.signal.aborted) controller.abort()
      return fs.readFile(p, opts)
    })
    const res = await grepFallbackJs(root, root, 'Needle', baseArgs(), controller.signal, () => {}, 60_000, { readFile })
    // 改造 2:异步读取边界必须挂 signal(真正的中止点),不是同步循环内的死检查
    expect(seenSignals[0]).toBe(controller.signal)
    expect(res.aborted).toBe(true)
    expect(readFile).toHaveBeenCalledTimes(1)
    await rmRoot(root)
  })

  it('T-B5:时间上界——到期返回 timedOut + partial,摘要可见不静默', async () => {
    const root = await makeTree()
    let calls = 0
    const now = vi.fn(() => {
      calls += 1
      return calls >= 4 ? 1_000_000 : 0
    })
    const res = await grepFallbackJs(root, root, 'Needle', baseArgs(), new AbortController().signal, () => {}, 60_000, { now })
    expect(res.timedOut).toBe(true)
    expect(res.partial).toBe(true)
    expect(res.boundarySummary).toContain('超时')
    await rmRoot(root)
  })
})

describe('§3.8 降级矩阵:resolveGrepEngine(纯函数裁定)', () => {
  it.each(['not_found', 'permission_denied', 'spawn_failed', 'exec_format', 'unsupported', 'not_file'] as const)('%s → walk 降级', (reason) => {
    expect(resolveGrepEngine(reason)).toEqual({ engine: 'walk', reason })
  })

  it('resource_exhausted → 不降级(显式报错 + 稍后重试;fd 耗尽在降级路径同样存在)', () => {
    expect(resolveGrepEngine('resource_exhausted')).toEqual({ engine: 'error', reason: 'resource_exhausted' })
  })
})

describe('grepExecutor 降级接线(三出口收敛 + 降级标识,AC12/AC14/T-B7/T-B9)', () => {
  let root = ''
  let cache: FileStateCache
  let ctx: ToolExecutionContext
  let file = ''
  let input: Record<string, unknown>

  beforeEach(async () => {
    root = await fs.realpath(await makeTree())
    cache = new FileStateCache()
    ctx = {
      workDir: root,
      userDataDir: path.join(root, '.userdata'),
      requestId: 'req-test',
      toolUseId: 'tool-test',
      sessionId: 'session-test',
      sendProgress: vi.fn(),
      recordDiagnostic: vi.fn(),
      signal: AbortSignal.timeout(30_000),
      fileStateCache: cache,
      toolsConfig: { ...({ grepTimeoutSec: 60 } as ToolExecutionContext['toolsConfig']) }
    }
    file = path.join(root, 'a.txt')
    input = { pattern: 'Needle', path: file }
    const stat = await fs.stat(file)
    ctx.readExecutionPermit = buildReadExecutionPermit({
      requestId: ctx.requestId!,
      toolUseId: ctx.toolUseId!,
      toolName: 'grep',
      input,
      facts: [{
        factId: 'grep-fact',
        decisionRuleId: 'read-group-workdir-allow',
        normalizedPath: file,
        zone: 'workdir-normal',
        targetKind: 'file',
        identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
      }]
    })
  })

  afterEach(async () => {
    await rmRoot(root)
    ripgrep.resolve.mockReset()
    ripgrep.inspect.mockReset()
  })

  it('出口① resolve 失败(unsupported)→ 自动降级,结果带标识前缀与 walk 引擎', async () => {
    ripgrep.resolve.mockReturnValue({ path: null, source: 'development', platform: process.platform, arch: process.arch, reason: 'unsupported' })
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    const output = String((res.data as { output?: string }).output)
    expect(output.startsWith('[降级搜索：内置 ripgrep 不可用，已用内置后备引擎完成')).toBe(true)
    expect((res.data as { searchScope?: { engine?: string } }).searchScope).toMatchObject({ engine: 'walk' })
    expect(output).toContain('a.txt')
    expect(output).toContain('能力边界见末尾摘要')
  })

  it('出口② inspect 失败(not_found)→ 自动降级(场景 B/D2 最高频路径)', async () => {
    ripgrep.resolve.mockReturnValue({ path: path.join(root, 'missing-rg'), source: 'development', platform: process.platform, arch: process.arch })
    ripgrep.inspect.mockResolvedValue({ available: false, reason: 'not_found' })
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    const output = String((res.data as { output?: string }).output)
    expect(output).toContain('[降级搜索：')
    expect(output).toContain('a.txt')
  })

  it('出口③ spawn 阶段失败(not_found)→ 同样收敛到降级判定点', async () => {
    ripgrep.resolve.mockReturnValue({ path: 'rg-should-not-spawn', source: 'development', platform: process.platform, arch: process.arch })
    ripgrep.inspect.mockResolvedValue({ available: true })
    ctx.grepSpawnProcess = (binary, rgArgs, options) => spawn('definitely-missing-rg-binary-xyz', ['-x', binary, ...rgArgs], options)
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    const output = String((res.data as { output?: string }).output)
    expect(output).toContain('[降级搜索：')
    expect(output).toContain('a.txt')
  })

  it('降级 no_match 不得是裸「No matches found」——必须带范围与摘要(AC13)', async () => {
    ripgrep.resolve.mockReturnValue({ path: null, source: 'development', platform: process.platform, arch: process.arch, reason: 'unsupported' })
    const missInput = { pattern: 'ZipZapAbsent', path: file }
    const stat = await fs.stat(file)
    ctx.readExecutionPermit = buildReadExecutionPermit({
      requestId: ctx.requestId!,
      toolUseId: ctx.toolUseId!,
      toolName: 'grep',
      input: missInput,
      facts: [{
        factId: 'grep-fact',
        decisionRuleId: 'read-group-workdir-allow',
        normalizedPath: file,
        zone: 'workdir-normal',
        targetKind: 'file',
        identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
      }]
    })
    const res = await grepExecutor.execute(missInput, ctx)
    expect(res.success).toBe(true)
    const output = String((res.data as { output?: string }).output)
    expect(output).toContain('No matches found')
    expect(output).toContain('searched:')   // R6 范围说明
    expect(output).toContain('[降级搜索：')  // 降级标识仍在
  })

  it('resource_exhausted 不降级:显式报错,无降级标识', async () => {
    ripgrep.resolve.mockReturnValue({ path: 'rg-fake', source: 'development', platform: process.platform, arch: process.arch })
    ripgrep.inspect.mockResolvedValue({ available: true })
    // stdin 用真实 Duplex:Windows 固定句柄路径会把文件流 pipe 进 stdin
    const fakeProc = Object.assign(new EventEmitter(), { stdin: new PassThrough() }) as unknown as ChildProcess
    ctx.grepSpawnProcess = () => {
      queueMicrotask(() => (fakeProc as unknown as EventEmitter).emit('error', Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })))
      return fakeProc
    }
    const res = await grepExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    // 不降级:无降级标识(Phase 4 分层文案落地后再约束具体措辞,此处只锁矩阵行为)
    expect(String(res.error)).not.toContain('[降级搜索：')
  })
})
