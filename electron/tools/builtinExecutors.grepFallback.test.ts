import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grepExecutor, grepFallbackJs, type GrepExecArgs } from './builtinExecutors'
import { FileStateCache } from '../fileStateCache'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'

type GrepArgs = GrepExecArgs

function grepArgs(overrides: Partial<GrepArgs> = {}): GrepArgs {
  return {
    glob: undefined,
    outputMode: 'content',
    ignoreCase: false,
    showLineNumber: true,
    headLimit: 100,
    multiline: false,
    ...overrides
  }
}

function makeCtx(workDir: string): ToolExecutionContext {
  return {
    workDir,
    userDataDir: path.join(workDir, '.userdata'),
    requestId: 'req-test',
    toolUseId: 'tool-test',
    sessionId: 'session-test',
    sendProgress: vi.fn(),
    signal: AbortSignal.timeout(30_000),
    fileStateCache: new FileStateCache(),
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false }
  }
}

describe('grepFallbackJs 单文件搜索', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-fb-')))
    await fs.mkdir(path.join(tmpDir, 'docs'))
    await fs.writeFile(
      path.join(tmpDir, 'docs', 'tech-design.md'),
      ['# Title', '', '## Alpha', 'some usage line', '', '### Beta', 'checkpoint here'].join('\n'),
      'utf8'
    )
    await fs.writeFile(path.join(tmpDir, 'docs', 'other.md'), 'no match here', 'utf8')
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('搜索目标是单个文件时能返回匹配行（content 模式）', async () => {
    const file = path.join(tmpDir, 'docs', 'tech-design.md')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      '^## ',
      grepArgs({ showLineNumber: true }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('## Alpha')
    expect(out).not.toBe('No matches found')
  })

  it('搜索目标是单个文件时能统计匹配数（count 模式）', async () => {
    const file = path.join(tmpDir, 'docs', 'tech-design.md')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'usage',
      grepArgs({ outputMode: 'count' }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toMatch(/tech-design\.md:1/)
    expect(out).not.toBe('No matches found')
  })

  it('搜索目标是单个文件时能列出文件（files_with_matches 模式）', async () => {
    const file = path.join(tmpDir, 'docs', 'tech-design.md')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'usage',
      grepArgs({ outputMode: 'files_with_matches' }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('Found 1 file')
    expect(out).toMatch(/tech-design\.md/)
  })

  it('单个文件无匹配时仍返回 No matches found', async () => {
    const file = path.join(tmpDir, 'docs', 'other.md')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'usage',
      grepArgs({ outputMode: 'content' }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toBe('No matches found')
  })

  it('目录递归搜索仍正常（回归）', async () => {
    const dir = path.join(tmpDir, 'docs')
    const out = await grepFallbackJs(
      tmpDir,
      dir,
      'checkpoint',
      grepArgs({ outputMode: 'content' }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('tech-design.md')
    expect(out).toContain('checkpoint here')
  })

  it('搜索目标是单个文件时 glob 不过滤（与 rg 语义一致）', async () => {
    const file = path.join(tmpDir, 'docs', 'tech-design.md')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'usage',
      grepArgs({ glob: '*.ts' }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('tech-design.md')
    expect(out).not.toBe('No matches found')
  })

  it('搜索已取消时，单文件分支返回 No matches found', async () => {
    const file = path.join(tmpDir, 'docs', 'tech-design.md')
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'usage',
      grepArgs({ outputMode: 'content' }),
      ctrl.signal,
      vi.fn()
    )
    expect(out).toBe('No matches found')
  })

  it('目录递归 + 含 / 的 glob 在反斜杠路径下也能匹配（posix 化）', async () => {
    const dir = path.join(tmpDir, 'docs')
    const out = await grepFallbackJs(
      tmpDir,
      dir,
      'usage',
      grepArgs({ glob: 'docs/*.md' }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('tech-design.md')
    expect(out).not.toBe('No matches found')
  })

  it('content 模式支持 context 上下文（匹配前后各 N 行）', async () => {
    const file = path.join(tmpDir, 'docs', 'tech-design.md')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'some usage',
      grepArgs({ outputMode: 'content', context: 1 }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('## Alpha')
    expect(out).toContain('some usage line')
    expect(out).not.toBe('No matches found')
  })

  it('content 模式支持 multiline 跨行匹配', async () => {
    const file = path.join(tmpDir, 'multi.md')
    await fs.writeFile(file, 'start\nmid\nend', 'utf8')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'start[\\s\\S]*end',
      grepArgs({ outputMode: 'content', multiline: true }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('start')
    expect(out).not.toBe('No matches found')
  })

  it('走 rg 路径时 head_limit 也生效（保留头部）', async () => {
    const rel = 'many.txt'
    await fs.writeFile(
      path.join(tmpDir, rel),
      Array.from({ length: 8 }, (_, i) => `line${i}`).join('\n') + '\nneedle\nneedle\nneedle',
      'utf8'
    )
    const res = await grepExecutor.execute(
      { pattern: 'needle', path: rel, output_mode: 'content', head_limit: 1 },
      makeCtx(tmpDir)
    )
    expect(res.success).toBe(true)
    const out = String(res.data?.output)
    const needleLines = out.split('\n').filter((l) => l.endsWith(':needle'))
    expect(needleLines.length).toBe(1)
  })

  it('count 模式也尊重 head_limit（rg 与 fallback 行为一致）', async () => {
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(path.join(tmpDir, `f${i}.md`), `needle ${i}`, 'utf8')
    }
    const res = await grepExecutor.execute(
      { pattern: 'needle', path: '.', output_mode: 'count', head_limit: 3 },
      makeCtx(tmpDir)
    )
    expect(res.success).toBe(true)
    const out = String(res.data?.output)
    const countLines = out.split('\n').filter((l) => /^.*f\d+\.md:1$/.test(l))
    expect(countLines.length).toBe(3)
  })

  it('files_with_matches 模式也尊重 head_limit（rg 与 fallback 行为一致）', async () => {
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(path.join(tmpDir, `f${i}.md`), `needle ${i}`, 'utf8')
    }
    const res = await grepExecutor.execute(
      { pattern: 'needle', path: '.', output_mode: 'files_with_matches', head_limit: 3 },
      makeCtx(tmpDir)
    )
    expect(res.success).toBe(true)
    const out = String(res.data?.output)
    const fileLines = out.split('\n').filter((l) => /f\d+\.md$/.test(l))
    expect(fileLines.length).toBe(3)
  })

  it('content 模式 show_line_number=false 时不输出行号（fallback）', async () => {
    const file = path.join(tmpDir, 'docs', 'tech-design.md')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'usage',
      grepArgs({ outputMode: 'content', showLineNumber: false }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('tech-design.md')
    expect(out).not.toMatch(/\.md:\d+:/)
  })

  it('multiline 匹配块单条超过 500 字符时截断（fallback）', async () => {
    const file = path.join(tmpDir, 'big.md')
    const bigBody = 'x'.repeat(600) + 'end'
    await fs.writeFile(file, 'start\n' + bigBody, 'utf8')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'start[\\s\\S]*end',
      grepArgs({ outputMode: 'content', multiline: true }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    expect(out).toContain('[行被截断]')
  })

  it('multiline 匹配块内嵌换行被转义，一条匹配只占一行（fallback）', async () => {
    const file = path.join(tmpDir, 'multi.md')
    await fs.writeFile(file, 'start\nmid\nend', 'utf8')
    const out = await grepFallbackJs(
      tmpDir,
      file,
      'start[\\s\\S]*end',
      grepArgs({ outputMode: 'content', multiline: true }),
      AbortSignal.timeout(30_000),
      vi.fn()
    )
    const lines = out.split('\n').filter((l) => l.includes('start') || l.includes('mid') || l.includes('end'))
    expect(lines.length).toBe(1)
    expect(out).toContain('\\n')
  })
})
