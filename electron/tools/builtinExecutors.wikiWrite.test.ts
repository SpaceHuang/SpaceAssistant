/**
 * T1.6/T1.7/T1.9：执行层写挂载 + 互斥 + 一致性守卫 + 远程断言。
 * - T1.6：permit.target.vocabularyPath 二次挂载比对（漂移 fail-closed）；别名写拒绝
 * - T1.7：挂载写落 {userData}/<rootPath>/；未挂载落 workDir 不变；wiki 根下拒 symlink/硬链接/目录目标；
 *         并发双写经互斥串行；写完成失效广播 hint 为词汇路径
 * - T1.9：远程断言按 scopeBase 结论（挂载对 realBase 断言；未挂载 workDir 断言不变）
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG, type WikiConfig } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import { editFileExecutor, writeFileExecutor } from './builtinExecutors'
import { probeWritePathFact, type WritePathProbeInput } from '../confirmation/extractors/writePathFacts'
import { buildWriteExecutionPermit } from '../confirmation/writeExecutionPermit'
import { canCreateSymlinks } from '../../src/test/symlinkCapability'
import { pendingWikiWriteCount } from '../wiki/wikiWriteMutex'

const dirs: string[] = []

async function tmpdir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return fs.realpath(dir)
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

function wikiConfig(rootPath = 'llm-wiki', enabled = true, legacyRootAliases: string[] = []): WikiConfig {
  return { ...DEFAULT_WIKI_CONFIG, enabled, rootPath, legacyRootAliases }
}

interface World {
  workDir: string
  userDataDir: string
  realBase: string
  ctx: ToolExecutionContext
}

async function setupWorld(overrides: { wikiConfig?: WikiConfig; lane?: 'desktop' | 'wechat' } = {}): Promise<World> {
  const root = await tmpdir('wiki-exec-')
  const workDir = path.join(root, 'proj')
  const userDataDir = path.join(root, 'ud')
  const realBase = path.join(userDataDir, 'llm-wiki')
  await fs.mkdir(path.join(workDir, 'llm-wiki'), { recursive: true })
  await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })
  await fs.mkdir(path.join(realBase, 'raw'), { recursive: true })
  const ctx: ToolExecutionContext = {
    workDir,
    userDataDir,
    requestId: 'req-wiki-exec',
    toolUseId: 'tool-wiki-exec',
    sessionId: 'session-wiki-exec',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: new FileStateCache(),
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false },
    wikiConfig: overrides.wikiConfig ?? wikiConfig(),
    lane: overrides.lane ?? 'desktop'
  }
  return { workDir, userDataDir, realBase, ctx }
}

/** 模拟 gate → 执行层链路：以（可选）锚点探测 fact 并签发 permit。 */
async function attachWritePermit(
  toolName: 'write_file' | 'edit_file',
  rawPath: string,
  ctx: ToolExecutionContext,
  input?: Record<string, unknown>
): Promise<void> {
  const toolInput = input ?? { path: rawPath, content: 'x' }
  const probeInput: WritePathProbeInput = {
    rawPath,
    workDir: ctx.workDir,
    userDataDir: ctx.userDataDir,
    homeDir: ctx.workDir,
    customSensitivePrefixes: []
  }
  const wc = ctx.wikiConfig
  if (wc) {
    const { resolveWikiMount } = await import('../wiki/wikiMount')
    const resolution = resolveWikiMount(ctx.workDir, wc, ctx.userDataDir, rawPath)
    if (resolution.mounted) {
      probeInput.mountAnchors = [{ base: resolution.realBase, vocabularyPrefix: resolution.vocabularyPath.split('/')[0] }]
      probeInput.sensitiveRootExemptions = [resolution.realBase]
    }
  }
  const fact = await probeWritePathFact(probeInput)
  ctx.writeExecutionPermit = buildWriteExecutionPermit({
    requestId: ctx.requestId,
    toolUseId: ctx.toolUseId,
    toolName,
    input: toolInput,
    target: fact,
    decisionRuleId: 'test-write',
    approval: 'auto-allow'
  })
}

describe('执行层写挂载（T1.6/T1.7）', () => {
  it('T1.6③/T1.7① 挂载写落 {userData}/<rootPath>/，permit 词汇一致放行', async () => {
    const { realBase, ctx } = await setupWorld()
    const rawPath = 'llm-wiki/wiki/index.md'
    const input = { path: rawPath, content: 'shared content' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    const written = await fs.readFile(path.join(realBase, 'wiki', 'index.md'), 'utf8')
    expect(written).toBe('shared content')
    // workDir 侧无实体文件产生（词汇路径已挂载）
    await expect(fs.readFile(path.join(ctx.workDir, 'llm-wiki', 'wiki', 'index.md'), 'utf8')).rejects.toThrow()
  })

  it('T1.7② 未挂载写落 workDir 不变', async () => {
    const { ctx } = await setupWorld()
    await fs.mkdir(path.join(ctx.workDir, 'notes'), { recursive: true })
    const input = { path: 'notes/plain.md', content: 'plain' }
    await attachWritePermit('write_file', 'notes/plain.md', ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    expect(await fs.readFile(path.join(ctx.workDir, 'notes', 'plain.md'), 'utf8')).toBe('plain')
  })

  it('T1.6④ 配置漂移（rootPath 改名）→ fail-closed 拒绝', async () => {
    const { ctx } = await setupWorld()
    const rawPath = 'llm-wiki/wiki/index.md'
    const input = { path: rawPath, content: 'x' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    // 模拟探测与执行之间配置漂移
    ctx.wikiConfig = wikiConfig('my-lib')

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    expect(res.diagnostic?.caseId).toBe('wiki-mount-consistency-mismatch')
    await expect(fs.access(path.join(ctx.userDataDir, 'llm-wiki', 'wiki', 'index.md'))).rejects.toThrow()
    await expect(fs.access(path.join(ctx.userDataDir, 'my-lib', 'wiki', 'index.md'))).rejects.toThrow()
  })

  it('T1.7⑤ 只读别名写 → 拒绝 + 引导文案', async () => {
    const { ctx } = await setupWorld({ wikiConfig: wikiConfig('llm-wiki', true, ['old-wiki']) })
    const rawPath = 'old-wiki/wiki/index.md'
    const input = { path: rawPath, content: 'x' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    expect(res.diagnostic?.caseId).toBe('wiki-readonly-alias-write-denied')
  })

  it('T1.7③ wiki 根下拒硬链接目标（symlink 用例按能力探测跳过）', async () => {
    const { realBase, ctx } = await setupWorld()
    const target = path.join(realBase, 'wiki', 'hardlinked.md')
    await fs.writeFile(target, 'v1')
    await fs.writeFile(path.join(realBase, 'wiki', 'other.md'), 'v1')
    try {
      await fs.link(path.join(realBase, 'wiki', 'other.md'), target)
    } catch {
      return // 平台不支持硬链接
    }
    const rawPath = 'llm-wiki/wiki/hardlinked.md'
    const input = { path: rawPath, content: 'x' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    expect(res.diagnostic?.caseId).toBe('write-target-type-mismatch')
  })

  it('T1.7③b wiki 根下拒 symlink 目标', async () => {
    if (!(await canCreateSymlinks())) return
    const { realBase, ctx } = await setupWorld()
    await fs.writeFile(path.join(realBase, 'wiki', 'real.md'), 'v1')
    await fs.symlink(path.join(realBase, 'wiki', 'real.md'), path.join(realBase, 'wiki', 'linked.md'))
    const rawPath = 'llm-wiki/wiki/linked.md'
    const input = { path: rawPath, content: 'x' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    expect(res.diagnostic?.caseId).toBe('write-target-type-mismatch')
  })

  it('T1.7④ 并发双写同 wiki 文件：走互斥区且终态无交错产物', async () => {
    const { realBase, ctx } = await setupWorld()
    const rawPath = 'llm-wiki/wiki/log.md'
    const absPath = path.join(realBase, 'wiki', 'log.md')
    await fs.writeFile(absPath, 'seed')
    const mutexMod = await import('../wiki/wikiWriteMutex')
    const acquireSpy = vi.spyOn(mutexMod, 'acquireWikiWriteMutex')
    const ctxA = { ...ctx, requestId: 'req-a', toolUseId: 'tool-a' } as ToolExecutionContext
    const ctxB = { ...ctx, requestId: 'req-b', toolUseId: 'tool-b' } as ToolExecutionContext

    const inputA = { path: rawPath, old_string: 'seed', new_string: 'seedA' }
    const inputB = { path: rawPath, old_string: 'seed', new_string: 'seedB' }
    await attachWritePermit('edit_file', rawPath, ctxA, inputA)
    await attachWritePermit('edit_file', rawPath, ctxB, inputB)
    const realStat = await fs.stat(absPath)
    for (const c of [ctxA, ctxB]) {
      c.fileStateCache.set(absPath, { path: absPath, content: 'seed', mtime: realStat.mtimeMs, readAt: Date.now(), isPartial: false })
    }

    const [ra, rb] = await Promise.all([
      editFileExecutor.execute(inputA, ctxA),
      editFileExecutor.execute(inputB, ctxB)
    ])
    // 两个写执行体都进入了文件互斥区（T1.7 互斥接入证据）
    expect(acquireSpy).toHaveBeenCalledTimes(2)
    expect(acquireSpy.mock.calls[0][0].toLowerCase()).toBe(absPath.toLowerCase())
    // 同文件读-改-写被互斥/外部修改防护约束：终态必为某一次编辑的完整结果，绝无交错产物
    const final = await fs.readFile(absPath, 'utf8')
    expect(final === 'seedA' || final === 'seedB' || final === 'seed').toBe(true)
    expect(final).not.toContain('seedAseedB')
    expect(ra.success || rb.success).toBe(true)
    expect(pendingWikiWriteCount()).toBe(0)
    acquireSpy.mockRestore()
  }, 20000)

  it('T1.7⑥ 挂载写完成 → 失效广播 hint 为词汇路径（不含真实路径）', async () => {
    const { ctx } = await setupWorld()
    const notify = await import('../fileTreeSyncNotify')
    const spy = vi.spyOn(notify, 'notifyFileTreeChanged')
    const rawPath = 'llm-wiki/wiki/broadcast.md'
    const input = { path: rawPath, content: 'x' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    const event = spy.mock.calls[0][1]
    expect(event.kind).toBe('paths')
    expect((event as { relPaths: string[] }).relPaths).toEqual(['llm-wiki/wiki/broadcast.md'])
    const serialized = JSON.stringify(spy.mock.calls[0])
    expect(serialized).not.toContain(ctx.userDataDir)
    spy.mockRestore()
  })
})

describe('远程写断言（T1.9）', () => {
  it('T1.9① 远程 lane 写 wiki 页 → 通过（对 realBase 断言 inside）', async () => {
    const { ctx } = await setupWorld({ lane: 'wechat' })
    ctx.remoteContext = { source: 'wechat', messageId: 'm1', confirmPolicy: 'im_confirm' }
    const rawPath = 'llm-wiki/wiki/remote-page.md'
    const input = { path: rawPath, content: 'x' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
  })

  it('T1.9③ 远程 lane 写 workDir 外非 wiki → remote-write-target-outside-workdir', async () => {
    const { ctx } = await setupWorld({ lane: 'wechat' })
    ctx.remoteContext = { source: 'wechat', messageId: 'm1', confirmPolicy: 'im_confirm' }
    const outside = await tmpdir('wiki-exec-out-')
    const rawPath = path.join(outside, 'evil.md')
    const input = { path: rawPath, content: 'x' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    expect(res.diagnostic?.caseId).toBe('remote-write-target-outside-workdir')
  })

  it('T1.9④ 远程 lane 写只读别名 → 拒绝', async () => {
    const { ctx } = await setupWorld({ lane: 'wechat', wikiConfig: wikiConfig('llm-wiki', true, ['old-wiki']) })
    ctx.remoteContext = { source: 'wechat', messageId: 'm1', confirmPolicy: 'im_confirm' }
    const rawPath = 'old-wiki/wiki/index.md'
    const input = { path: rawPath, content: 'x' }
    await attachWritePermit('write_file', rawPath, ctx, input)

    const res = await writeFileExecutor.execute(input, ctx)
    expect(res.success).toBe(false)
    expect(res.diagnostic?.caseId).toBe('wiki-readonly-alias-write-denied')
    // 远程 lane 返回引导文案（指向共享库新路径）
    expect(res.error).toContain('llm-wiki/')
  })
})
