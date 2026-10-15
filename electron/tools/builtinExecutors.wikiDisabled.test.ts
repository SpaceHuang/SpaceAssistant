/**
 * W3：知识库未启用时 `llm-wiki/` 前缀不挂载——write 会落 workDir 普通路径产生误导性成功，
 * read/list/grep 同理搜不到。工具层在路径解析入口统一拦截并给出与 skill 异常处理
 * 一致的引导文案（fail-closed，不绕行）。
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'
import { editFileExecutor, grepExecutor, listDirectoryExecutor, readFileExecutor, writeFileExecutor } from './builtinExecutors'

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

async function setupCtx(wikiEnabled: boolean): Promise<ToolExecutionContext> {
  const root = await tmpdir('wiki-disabled-')
  const workDir = path.join(root, 'proj')
  await fs.mkdir(workDir, { recursive: true })
  return {
    workDir,
    userDataDir: path.join(root, 'ud'),
    requestId: 'req-wiki-disabled',
    toolUseId: 'tool-wiki-disabled',
    sessionId: 'session-wiki-disabled',
    lane: 'desktop',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: new FileStateCache(),
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
    wikiConfig: { ...DEFAULT_WIKI_CONFIG, enabled: wikiEnabled }
  }
}

describe('知识库未启用时 llm-wiki/ 前缀兜底引导（W3）', () => {
  it('read_file：前缀命中且未启用 → 引导开启，不落 workDir 读取', async () => {
    const ctx = await setupCtx(false)
    const res = await readFileExecutor.execute({ path: 'llm-wiki/wiki/index.md' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('共享知识库未启用')
    expect(res.error).toContain('设置 → Wiki')
    expect(res.diagnostic).toMatchObject({ caseId: 'wiki-vocabulary-disabled', retryable: true })
  })

  it('list_directory：前缀根目录同样拦截', async () => {
    const ctx = await setupCtx(false)
    const res = await listDirectoryExecutor.execute({ path: 'llm-wiki' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('共享知识库未启用')
    expect(res.diagnostic).toMatchObject({ caseId: 'wiki-vocabulary-disabled' })
  })

  it('grep：显式 path 前缀命中时拦截', async () => {
    const ctx = await setupCtx(false)
    const res = await grepExecutor.execute({ pattern: 'wiki', path: 'llm-wiki' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('共享知识库未启用')
    expect(res.diagnostic).toMatchObject({ caseId: 'wiki-vocabulary-disabled' })
  })

  it('write_file：前缀命中且未启用 → 拦截，绝不产生 workDir 误导性写入', async () => {
    const ctx = await setupCtx(false)
    const res = await writeFileExecutor.execute({ path: 'llm-wiki/notes/a.md', content: 'body' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('共享知识库未启用')
    await expect(fs.stat(path.join(ctx.workDir, 'llm-wiki', 'notes', 'a.md'))).rejects.toThrow()
  })

  it('edit_file：前缀命中且未启用 → 同样拦截', async () => {
    const ctx = await setupCtx(false)
    const res = await editFileExecutor.execute({ path: 'llm-wiki/notes/a.md', oldString: 'a', newString: 'b' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('共享知识库未启用')
  })

  it('启用状态下不拦截（挂载/permit 链路照旧接管）', async () => {
    const ctx = await setupCtx(true)
    const res = await readFileExecutor.execute({ path: 'llm-wiki/wiki/index.md' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error ?? '').not.toContain('共享知识库未启用')
  })

  it('未启用但路径不带前缀 → 维持既有路径（不误伤普通文件）', async () => {
    const ctx = await setupCtx(false)
    const res = await readFileExecutor.execute({ path: 'plain.txt' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error ?? '').not.toContain('共享知识库未启用')
  })

  it.each([
    ['大小写变体（Windows 同目录）', 'LLM-WIKI/notes/a.md'],
    ['前导 ./ 变体', './llm-wiki/notes/a.md']
  ])('%s → 与挂载判定同一决策点拦截', async (_name, rawPath) => {
    const ctx = await setupCtx(false)
    const res = await readFileExecutor.execute({ path: rawPath }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('共享知识库未启用')
    expect(res.diagnostic).toMatchObject({ caseId: 'wiki-vocabulary-disabled' })
  })

  it('前导 / 绝对形态：挂载侧越界不挂载（启用时同样被范围守卫拒绝）→ 不给引导、不误导成功', async () => {
    const ctx = await setupCtx(false)
    const res = await readFileExecutor.execute({ path: '/llm-wiki/notes/a.md' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error ?? '').not.toContain('共享知识库未启用')
  })

  it('workDir 内指向 llm-wiki/ 的绝对路径 → 拦截', async () => {
    const ctx = await setupCtx(false)
    const abs = path.join(ctx.workDir, 'llm-wiki', 'notes', 'a.md')
    const res = await readFileExecutor.execute({ path: abs }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('共享知识库未启用')
  })

  it.each([
    ['write_file 大小写变体', (ctx: ToolExecutionContext) => writeFileExecutor.execute({ path: 'LLM-WIKI/notes/a.md', content: 'body' }, ctx)],
    ['grep 大小写变体', (ctx: ToolExecutionContext) => grepExecutor.execute({ pattern: 'wiki', path: 'LLM-WIKI' }, ctx)]
  ])('%s → 同样拦截', async (_name, run) => {
    const ctx = await setupCtx(false)
    const res = await run(ctx)
    expect(res.success).toBe(false)
    expect(res.error).toContain('共享知识库未启用')
  })
})
