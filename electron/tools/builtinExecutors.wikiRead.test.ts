/**
 * T1.8：执行层读挂载。挂载命中时 permit 目标为 realBase 真实路径（探测层产出），
 * 执行层经 resolveReadPermitTarget 信任 permit 目标 + identity 复核；读 permit targets 携带
 * vocabularyPath 供卡片/审计展示。未挂载读行为不变。
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import { listDirectoryExecutor, readFileExecutor } from './builtinExecutors'
import { probeReadPathFact } from '../confirmation/extractors/readPathFacts'
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

interface World {
  workDir: string
  userDataDir: string
  realBase: string
  ctx: ToolExecutionContext
}

async function setupWorld(): Promise<World> {
  const root = await tmpdir('wiki-read-')
  const workDir = path.join(root, 'proj')
  const userDataDir = path.join(root, 'ud')
  const realBase = path.join(userDataDir, 'llm-wiki')
  await fs.mkdir(path.join(workDir), { recursive: true })
  await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })
  await fs.writeFile(path.join(realBase, 'wiki', 'index.md'), 'shared content')
  await fs.writeFile(path.join(realBase, 'wiki', 'page.md'), 'page body')
  const ctx: ToolExecutionContext = {
    workDir,
    userDataDir,
    requestId: 'req-wiki-read',
    toolUseId: 'tool-wiki-read',
    sessionId: 'session-wiki-read',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: new FileStateCache(),
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
    // 挂载世界 = 知识库已启用（生产中 enabled 时 ctx.wikiConfig 必有；执行层以此为挂载前提）
    wikiConfig: { ...DEFAULT_WIKI_CONFIG, enabled: true }
  }
  return { workDir, userDataDir, realBase, ctx }
}

/** 以挂载锚点探测并签发读 permit（模拟 gate → 执行层链路）。 */
async function attachMountedReadPermit(
  toolName: 'read_file' | 'list_directory',
  rawPath: string,
  ctx: ToolExecutionContext,
  vocabularyPath: string
): Promise<void> {
  const { resolveWikiMount } = await import('../wiki/wikiMount')
  const wc = { enabled: true, rootPath: 'llm-wiki' } as const
  const resolution = resolveWikiMount(ctx.workDir, wc as never, ctx.userDataDir, rawPath)
  if (!resolution.mounted) throw new Error('fixture expects mounted path')
  const fact = await probeReadPathFact({
    rawPath: resolution.realRel,
    workDir: resolution.realBase,
    userDataDir: ctx.userDataDir,
    homeDir: ctx.workDir,
    customSensitivePrefixes: [],
    sensitiveRootExemptions: [resolution.realBase]
  })
  const targetKind = toolName === 'list_directory' && (fact.targetKind === 'directory' || fact.resolvedKind === 'directory')
    ? 'directory'
    : fact.targetKind
  ctx.readExecutionPermit = buildReadExecutionPermit({
    requestId: ctx.requestId,
    toolUseId: ctx.toolUseId,
    toolName,
    input: { path: rawPath },
    facts: [{
      factId: `fact-${fact.normalizedPath}`,
      decisionRuleId: 'test-mounted-read',
      normalizedPath: fact.normalizedPath,
      zone: fact.zone,
      targetKind,
      ...(fact.resolvedKind ? { resolvedKind: fact.resolvedKind } : {}),
      ...(fact.identity ? { identity: fact.identity } : {}),
      ...(toolName === 'list_directory' ? { scope: 'direct-entries' as const } : {}),
      vocabularyPath
    }]
  })
}

describe('执行层读挂载（T1.8）', () => {
  it('T1.8① 挂载读返回共享库内容（permit 目标为真实路径 + identity 复核）', async () => {
    const { realBase, ctx } = await setupWorld()
    await attachMountedReadPermit('read_file', 'llm-wiki/wiki/index.md', ctx, 'llm-wiki/wiki/index.md')

    const res = await readFileExecutor.execute({ path: 'llm-wiki/wiki/index.md' }, ctx)
    expect(res.success).toBe(true)
    expect((res.data as { content: string }).content).toBe('shared content')
  })

  it('T1.8② 目录 permit（list_directory）挂载解析 + identity 复核正常', async () => {
    const { realBase, ctx } = await setupWorld()
    await attachMountedReadPermit('list_directory', 'llm-wiki/wiki', ctx, 'llm-wiki/wiki')

    const res = await listDirectoryExecutor.execute({ path: 'llm-wiki/wiki' }, ctx)
    expect(res.success).toBe(true)
    const entries = (res.data as { entries: Array<{ name: string; path: string }> }).entries
    expect(entries.map((e) => e.name).sort()).toEqual(['index.md', 'page.md'])
    // BLK-8：条目 path 为词汇路径（无 ../..、无 userData 片段，Agent 可回喂）
    for (const entry of entries) {
      expect(entry.path).toMatch(/^llm-wiki\/wiki\//)
      expect(entry.path).not.toContain('..')
      expect(entry.path).not.toContain(ctx.userDataDir)
    }
  })

  it('T1.8③ 未挂载读不变：workDir 内文件照常', async () => {
    const { workDir, ctx } = await setupWorld()
    await fs.writeFile(path.join(workDir, 'plain.txt'), 'plain text')
    const { attachTestReadPermit } = await import('./readPermitTestUtils')
    const input = { path: 'plain.txt' }
    await attachTestReadPermit('read_file', input, ctx)

    const res = await readFileExecutor.execute(input, ctx)
    expect(res.success).toBe(true)
    expect((res.data as { content: string }).content).toBe('plain text')
  })

  it('T1.8④ permit target 携带 vocabularyPath（validate 通过；卡片展示由信号层断言）', async () => {
    const { ctx } = await setupWorld()
    await attachMountedReadPermit('read_file', 'llm-wiki/wiki/page.md', ctx, 'llm-wiki/wiki/page.md')
    expect(ctx.readExecutionPermit?.targets[0]?.vocabularyPath).toBe('llm-wiki/wiki/page.md')
    // 非法 vocabularyPath 被 buildReadExecutionPermit 拒绝
    expect(() => buildReadExecutionPermit({
      requestId: 'r', toolUseId: 't', toolName: 'read_file', input: { path: 'x' },
      facts: [{ factId: 'f', decisionRuleId: 'rule', normalizedPath: 'C:\\x', zone: 'workdir-normal', targetKind: 'file', vocabularyPath: '' }]
    })).toThrow()
  })
})
