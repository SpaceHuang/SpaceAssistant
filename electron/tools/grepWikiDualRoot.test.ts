/**
 * T1.11a/b/c：grep 双根编排。
 * - a：无 path → 双根（workDir + 共享根）；wiki 停用单根；显式 path=wiki 词汇 → 仅 wiki 根
 * - b：结果合并、wiki 路径改写回词汇、排序确定、head_limit 跨根统一、单根降级不影响另一根
 * - c：workDir 根扫描排除挂载词汇前缀实体目录（§7.7 去重）
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG, type WikiConfig } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import { grepExecutor } from './builtinExecutors'
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'

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

function wikiConfig(legacyRootAliases: string[] = []): WikiConfig {
  return { ...DEFAULT_WIKI_CONFIG, rootPath: 'llm-wiki', legacyRootAliases }
}

interface World {
  workDir: string
  userDataDir: string
  realBase: string
  ctx: ToolExecutionContext
  root: string
}

async function setupWorld(opts: { withResidue?: boolean } = {}): Promise<World> {
  const root = await tmpdir('wiki-grep-')
  const workDir = path.join(root, 'proj')
  const userDataDir = path.join(root, 'ud')
  const realBase = path.join(userDataDir, 'llm-wiki')
  await fs.mkdir(path.join(workDir, 'code'), { recursive: true })
  await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })
  await fs.writeFile(path.join(workDir, 'code', 'a.txt'), 'needle in workdir\n')
  await fs.writeFile(path.join(realBase, 'wiki', 'shared.md'), 'needle in shared wiki\n')
  if (opts.withResidue) {
    // workDir 内实体残留：迁移前的旧 wiki 目录（含与共享根同词汇路径的文件）
    await fs.mkdir(path.join(workDir, 'llm-wiki', 'wiki'), { recursive: true })
    await fs.writeFile(path.join(workDir, 'llm-wiki', 'wiki', 'shared.md'), 'STALE residue copy\n')
    await fs.writeFile(path.join(workDir, 'llm-wiki', 'wiki', 'only-residue.md'), 'needle only in residue\n')
  }
  const ctx: ToolExecutionContext = {
    workDir,
    userDataDir,
    requestId: 'req-wiki-grep',
    toolUseId: 'tool-wiki-grep',
    sessionId: 'session-wiki-grep',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(60_000),
    fileStateCache: new FileStateCache(),
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
    wikiConfig: wikiConfig()
  }
  return { workDir, userDataDir, realBase, ctx, root }
}

/** 模拟 gate：无 path 的 grep 以 workDir 根目录 subtree permit 签发（'.' 探测） */
async function attachWorkDirGrepPermit(ctx: ToolExecutionContext, input: Record<string, unknown>): Promise<void> {
  const stat = await fs.stat(ctx.workDir)
  ctx.readExecutionPermit = buildReadExecutionPermit({
    requestId: ctx.requestId,
    toolUseId: ctx.toolUseId,
    toolName: 'grep',
    input,
    facts: [{
      factId: 'grep-root-fact',
      decisionRuleId: 'read-group-workdir-allow',
      normalizedPath: ctx.workDir,
      zone: 'workdir-normal',
      targetKind: 'directory',
      scope: 'subtree',
      identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }
    }]
  })
}

/** 模拟 gate：显式 path=wiki 词汇时的挂载探测 + permit 签发 */
async function attachWikiPathGrepPermit(ctx: ToolExecutionContext, input: Record<string, unknown>): Promise<void> {
  const { resolveWikiMount } = await import('../wiki/wikiMount')
  const { probeReadPathFact } = await import('../confirmation/extractors/readPathFacts')
  const wc = ctx.wikiConfig!
  const resolution = resolveWikiMount(ctx.workDir, wc, ctx.userDataDir, input.path as string)
  if (!resolution.mounted) throw new Error('fixture expects mounted path')
  const fact = await probeReadPathFact({
    rawPath: resolution.realRel || '.',
    workDir: resolution.realBase,
    userDataDir: ctx.userDataDir,
    homeDir: ctx.workDir,
    customSensitivePrefixes: [],
    sensitiveRootExemptions: [resolution.realBase]
  })
  ctx.readExecutionPermit = buildReadExecutionPermit({
    requestId: ctx.requestId,
    toolUseId: ctx.toolUseId,
    toolName: 'grep',
    input,
    facts: [{
      factId: `fact-${fact.normalizedPath}`,
      decisionRuleId: 'read-group-workdir-allow',
      normalizedPath: fact.normalizedPath,
      zone: fact.zone,
      targetKind: 'directory',
      scope: 'subtree',
      ...(fact.identity ? { identity: fact.identity } : {}),
      vocabularyPath: input.path as string
    }]
  })
}

async function runGrep(ctx: ToolExecutionContext, input: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string; diagnostic?: { caseId?: string } }> {
  // 模拟 gate：无 path → workDir 根目录 permit（'.'）；显式 path=wiki 词汇 → 挂载 permit
  const rawPath = typeof input.path === 'string' ? input.path : undefined
  if (rawPath === undefined) {
    await attachWorkDirGrepPermit(ctx, input)
  } else if (ctx.wikiConfig) {
    const { resolveWikiMount } = await import('../wiki/wikiMount')
    const resolution = resolveWikiMount(ctx.workDir, ctx.wikiConfig, ctx.userDataDir, rawPath)
    if (resolution.mounted) await attachWikiPathGrepPermit(ctx, input)
  }
  const res = await grepExecutor.execute(input, ctx)
  const data = res.data as { output?: string } | undefined
  return { success: res.success, output: data?.output, error: res.error, diagnostic: res.diagnostic as { caseId?: string } | undefined }
}

describe('grep 双根编排（T1.11a）', () => {
  it('无 path 双根搜索拒绝指向自定义敏感目录的共享根符号链接', async () => {
    const world = await setupWorld()
    const sensitiveDir = path.join(world.root, 'custom-sensitive')
    await fs.mkdir(sensitiveDir, { recursive: true })
    await fs.writeFile(path.join(sensitiveDir, 'secret.md'), 'PRIVATE_CUSTOM_SENSITIVE_CONTENT needle\n')
    await fs.rm(world.realBase, { recursive: true })
    await fs.symlink(sensitiveDir, world.realBase, 'dir')
    world.ctx.shellConfig = { customSensitivePrefixes: [sensitiveDir] } as ToolExecutionContext['shellConfig']

    const res = await runGrep(world.ctx, { pattern: 'needle', output_mode: 'content' })
    expect(res.output).not.toContain('PRIVATE_CUSTOM_SENSITIVE_CONTENT')
    expect(res.output).not.toContain('secret.md')
  })

  it('无 path 双根搜索拒绝指向共享库外普通目录的共享根符号链接', async () => {
    const world = await setupWorld()
    const externalDir = path.join(world.root, 'external-wiki')
    await fs.mkdir(externalDir, { recursive: true })
    await fs.writeFile(path.join(externalDir, 'outside.md'), 'OUTSIDE_SHARED_ROOT needle\n')
    await fs.rm(world.realBase, { recursive: true })
    await fs.symlink(externalDir, world.realBase, 'dir')

    const res = await runGrep(world.ctx, { pattern: 'needle', output_mode: 'content' })
    expect(res.output).not.toContain('OUTSIDE_SHARED_ROOT')
    expect(res.output).not.toContain('outside.md')
  })

  it('a① 无 path + wiki 启用 → workDir 与共享根双根命中，wiki 路径为词汇形态', async () => {
    const { ctx } = await setupWorld()
    const res = await runGrep(ctx, { pattern: 'needle', output_mode: 'content' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('needle in workdir')
    expect(res.output).toContain('llm-wiki/wiki/shared.md')
    expect(res.output).toContain('needle in shared wiki')
  })

  it('a③ 显式 path=wiki 词汇 → 仅共享根子路径（挂载 permit 单根）', async () => {
    const { ctx } = await setupWorld()
    const res = await runGrep(ctx, { pattern: 'needle', output_mode: 'content', path: 'llm-wiki' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('llm-wiki/wiki/shared.md')
    expect(res.output).not.toContain('needle in workdir')
  })
})

describe('grep 双根合并（T1.11b）', () => {
  it('b① 合并结果排序确定：同输入两次运行输出逐字节一致', async () => {
    const { ctx } = await setupWorld()
    const r1 = await runGrep(ctx, { pattern: 'needle', output_mode: 'content' })
    const ctx2 = { ...ctx, requestId: 'req-2', toolUseId: 'tool-2' } as ToolExecutionContext
    const r2 = await runGrep(ctx2, { pattern: 'needle', output_mode: 'content' })
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(r1.output).toBe(r2.output)
  })

  it('b③ 两根均无命中 → 无匹配文案含双根', async () => {
    const { ctx } = await setupWorld()
    const res = await runGrep(ctx, { pattern: 'no-such-needle-anywhere', output_mode: 'content' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('No matches found')
    expect(res.output).toContain('llm-wiki')
  })

  it('b④ head_limit 跨根统一：合并后统一截断并标注', async () => {
    const { ctx } = await setupWorld()
    // 两个根共 2 行命中，head_limit=1 → 恰好 1 行 + 截断标注
    const res = await runGrep(ctx, { pattern: 'needle', output_mode: 'content', head_limit: 1 })
    expect(res.success).toBe(true)
    expect(res.output).toContain('已按 head_limit=1 截断')
    const bodyLines = (res.output ?? '').split('\n').filter((l) => l.includes('needle'))
    expect(bodyLines.length).toBe(1)
  })

  it('b⑤ files_with_matches 双根合并', async () => {
    const { ctx } = await setupWorld()
    const res = await runGrep(ctx, { pattern: 'needle', output_mode: 'files_with_matches' })
    expect(res.success).toBe(true)
    expect(res.output).toContain(`code${path.sep}a.txt`)
    expect(res.output).toContain('llm-wiki/wiki/shared.md')
    expect(res.output).not.toContain('ud')
  })
})

describe('workDir 根实体残留去重（T1.11c）', () => {
  it('c① 实体 llm-wiki/ 残留不被 workDir 根扫入：同词汇路径结果唯一（共享根提供）', async () => {
    const { ctx } = await setupWorld({ withResidue: true })
    const res = await runGrep(ctx, { pattern: 'needle', output_mode: 'content' })
    expect(res.success).toBe(true)
    // shared.md 仅来自共享根一份
    const sharedHits = (res.output ?? '').split('\n').filter((l) => l.includes('wiki/shared.md'))
    expect(sharedHits.length).toBe(1)
    expect(sharedHits[0]).toContain('needle in shared wiki')
    // 残留独有文件被排除（词汇路径由共享根唯一提供，§7.7）
    expect(res.output).not.toContain('only-residue.md')
    expect(res.output).not.toContain('STALE residue copy')
  })

  it('c② 共享根为空时残留内容不出现（引导先迁移语义）', async () => {
    const { ctx, realBase } = await setupWorld({ withResidue: true })
    await fs.rm(path.join(realBase, 'wiki', 'shared.md'))
    const res = await runGrep(ctx, { pattern: 'needle', output_mode: 'content' })
    expect(res.success).toBe(true)
    expect(res.output).not.toContain('only-residue.md')
  })
})
