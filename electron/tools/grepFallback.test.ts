import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { grepFallbackJs, type GrepExecArgs } from './builtinExecutors'
import { canCreateSymlinks } from '../../src/test/symlinkCapability'

const roots: string[] = []
const args = (overrides: Partial<GrepExecArgs> = {}): GrepExecArgs => ({
  outputMode: 'content', ignoreCase: false, showLineNumber: true, multiline: false,
  headLimit: 100, includeIgnored: false, ...overrides
})
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-grep-fallback-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('JavaScript grep fallback', () => {
  it('supports case insensitive regex, glob, line output, and context lines', async () => {
    const root = fixture({ 'src/a.ts': 'before\nNEEDLE-1\nafter\n', 'src/b.js': 'needle-2\n', 'skip.md': 'Needle' })
    const out = await grepFallbackJs(root, root, 'needle-[0-9]', args({ ignoreCase: true, glob: '*.ts', context: 1 }), new AbortController().signal, () => {})
    expect(out).toContain('src/a.ts-1-before')
    expect(out).toContain('src/a.ts:2:NEEDLE-1')
    expect(out).toContain('src/a.ts-3-after')
    expect(out).not.toContain('src/b.js')
  })

  it('treats glob metacharacters as literals without evaluating them as a main-thread regex', async () => {
    const root = fixture({ '(a+)+needle.ts': 'needle', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.ts': 'needle' })
    const out = await grepFallbackJs(root, root, 'needle', args({ glob: '(a+)+*.ts' }), new AbortController().signal, () => {})
    expect(out).toContain('(a+)+needle.ts')
    expect(out).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.ts')
  })

  it('rejects an invalid regex even when the search directory has no files', async () => {
    const root = fixture({})
    const out = await grepFallbackJs(root, root, '[', args(), new AbortController().signal, () => {})
    expect(out).toMatch(/^Error:/)
    expect(out).not.toBe('No matches found')
  })

  it('rejects an invalid regex when every file is excluded by the glob', async () => {
    const root = fixture({ 'readme.txt': 'content is excluded' })
    const out = await grepFallbackJs(root, root, '[', args({ glob: '*.js' }), new AbortController().signal, () => {})
    expect(out).toMatch(/^Error:/)
    expect(out).not.toBe('No matches found')
  })

  it('reads an explicitly authorized file from its permit handle after its path is replaced', async () => {
    const root = fixture({ 'target.txt': 'authorized content' })
    const outside = path.join(root, '..', `sa-grep-outside-${Date.now()}.txt`)
    fs.writeFileSync(outside, 'UNAUTHORIZED_SECRET')
    const target = path.join(root, 'target.txt')
    const handle = await fs.promises.open(target, 'r')
    try {
      fs.renameSync(target, `${target}.original`)
      fs.symlinkSync(outside, target)
      const out = await grepFallbackJs(root, target, 'content|SECRET', args(), new AbortController().signal, () => {}, 60_000, handle)
      expect(out).toContain('authorized content')
      expect(out).not.toContain('UNAUTHORIZED_SECRET')
    } finally {
      await handle.close()
      fs.rmSync(outside, { force: true })
    }
  })

  it('supports multiline matching and count output', async () => {
    const root = fixture({ 'a.txt': 'alpha\nbeta\nalpha beta\n' })
    const multiline = await grepFallbackJs(root, root, 'alpha\\nbeta', args({ multiline: true }), new AbortController().signal, () => {})
    expect(multiline).toContain('a.txt:1:alpha\\nbeta')
    const count = await grepFallbackJs(root, root, 'alpha', args({ outputMode: 'count' }), new AbortController().signal, () => {})
    expect(count).toContain('a.txt:2')
    expect(count).toContain('共 2 处匹配')
  })

  it('respects head limit and treats oversized and binary files as non-results', async () => {
    const root = fixture({ 'a.txt': 'needle\nneedle\n', 'large.txt': 'needle'.repeat(400_000), 'binary.bin': '\u0000needle' })
    const out = await grepFallbackJs(root, root, 'needle', args({ headLimit: 1 }), new AbortController().signal, () => {})
    expect(out).toContain('[共 1 条匹配')
    expect(out).not.toContain('large.txt')
    expect(out).not.toContain('binary.bin')
  })

  it('searches a 1.5 MiB file within the cloud fallback size limit', async () => {
    const root = fixture({ 'medium-large.txt': `${'x'.repeat(1_500_000)}\nNeedle at the end\n` })
    const out = await grepFallbackJs(root, root, 'Needle at the end', args(), new AbortController().signal, () => {})
    expect(out).toContain('medium-large.txt:2:Needle at the end')
    expect(out).not.toContain('[边界摘要]')
  })

  it('reports oversized files so a no-match result is visibly incomplete', async () => {
    const root = fixture({ 'large.txt': 'needle'.repeat(400_000) })
    const out = await grepFallbackJs(root, root, 'needle', args(), new AbortController().signal, () => {})
    expect(out).toContain('No matches found')
    expect(out).toContain('[边界摘要]')
    expect(out).toContain('large.txt')
    expect(out).toContain('可能包含匹配')
  })

  it('reports read errors instead of presenting them as a complete no-match result', async () => {
    const root = fixture({ 'blocked.txt': 'needle' })
    const out = await grepFallbackJs(root, root, 'needle', args(), new AbortController().signal, () => {}, 60_000, undefined, {
      readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    })
    expect(out).toContain('No matches found')
    expect(out).toContain('读取失败')
    expect(out).toContain('blocked.txt')
  })

  it('returns partial results with an explicit timeout boundary', async () => {
    const root = fixture({ 'a.txt': 'needle' })
    let calls = 0
    const now = (): number => (++calls > 4 ? 100_000 : 0)
    const out = await grepFallbackJs(root, root, 'needle', args(), new AbortController().signal, () => {}, 60_000, undefined, { now })
    expect(out).toContain('搜索超时')
    expect(out).toContain('[边界摘要]')
  })

  it('terminates catastrophic-backtracking regexes without blocking the main process', async () => {
    const root = fixture({ 'hostile.txt': `${'a'.repeat(30_000)}!` })
    const started = Date.now()
    const out = await grepFallbackJs(root, root, '(a+)+$', args(), new AbortController().signal, () => {}, 5_000)
    expect(out).toMatch(/超时/)
    expect(Date.now() - started).toBeLessThan(2_500)
  })

  it('cancels an in-flight regex worker promptly when the caller aborts', async () => {
    const root = fixture({ 'hostile.txt': `${'a'.repeat(30_000)}!` })
    const controller = new AbortController()
    const started = Date.now()
    const pending = grepFallbackJs(root, root, '(a+)+$', args(), controller.signal, () => {}, 5_000)
    setTimeout(() => controller.abort(), 40)
    await expect(pending).resolves.toBe('No matches found')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('honors the caller total timeout while matching in the worker', async () => {
    const root = fixture({ 'hostile.txt': `${'a'.repeat(30_000)}!` })
    const started = Date.now()
    const out = await grepFallbackJs(root, root, '(a+)+$', args(), new AbortController().signal, () => {}, 40)
    expect(out).toMatch(/超时/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('输出路径形态（D7/I6 最终口径：workDir 内相对、workDir 外绝对）', () => {
  // Windows 输出走平台分隔符（rg 组11c 实测同为反斜杠），断言用 path.sep 构造保持跨平台
  const relPath = (...segs: string[]) => segs.join(path.sep)

  it('AC-20b/AC-47：workDir 内目录搜索输出相对路径且无 ./ 前缀', async () => {
    const root = fixture({ 'sub/a.txt': 'NEEDLE\n' })
    const out = await grepFallbackJs(root, root, 'NEEDLE', args({ outputMode: 'files_with_matches' }), new AbortController().signal, () => {})
    expect(out).toContain(relPath('sub', 'a.txt'))
    expect(out).not.toMatch(/\.\\|\.\//)
    expect(out).not.toContain(root)
  })

  it('AC-20c：displayPath 解耦后 glob 过滤仍生效（*.ts 只留 ts）', async () => {
    const root = fixture({ 'src/a.ts': 'NEEDLE-ts\n', 'src/b.js': 'NEEDLE-js\n' })
    const out = await grepFallbackJs(root, root, 'NEEDLE', args({ outputMode: 'files_with_matches', glob: '*.ts' }), new AbortController().signal, () => {})
    expect(out).toContain(relPath('src', 'a.ts'))
    expect(out).not.toContain(relPath('src', 'b.js'))
  })

  it('AC-20d：单文件 walk 降级路径输出 workDir 内相对路径', async () => {
    const root = fixture({ 'solo.txt': 'NEEDLE\n' })
    const out = await grepFallbackJs(root, path.join(root, 'solo.txt'), 'NEEDLE', args({ outputMode: 'files_with_matches' }), new AbortController().signal, () => {})
    expect(out).toContain('solo.txt')
    expect(out).not.toContain(root)
  })

  it('AC-48：workDir 外搜索根输出绝对路径', async () => {
    const inner = fixture({ 'in-workdir.txt': 'placeholder\n' })
    const outsideDir = fs.mkdtempSync(path.join(path.dirname(inner), 'sa-grep-outside-'))
    roots.push(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'found.txt'), 'NEEDLE\n')
    const out = await grepFallbackJs(inner, outsideDir, 'NEEDLE', args({ outputMode: 'files_with_matches' }), new AbortController().signal, () => {})
    expect(out).toContain(path.join(outsideDir, 'found.txt'))
  })
})

describe('目录递归端到端（E1，AC-12/13/17 walk 侧）', () => {
  const relPath = (...segs: string[]) => segs.join(path.sep)

  it('递归命中多文件且默认忽略/隐藏/敏感条目不出现在结果（AC-12）', async () => {
    const root = fixture({
      'src/a.txt': 'NEEDLE\n',
      'src/nested/b.txt': 'NEEDLE\n',
      'node_modules/pkg/c.txt': 'NEEDLE\n',
      '.git/internal.txt': 'NEEDLE\n',
      '.env': 'NEEDLE\n',
      '.env.local': 'NEEDLE\n',
      'secrets/key.txt': 'NEEDLE\n',
      'dist/bundle.txt': 'NEEDLE\n'
    })
    const out = await grepFallbackJs(root, root, 'NEEDLE', args({ outputMode: 'files_with_matches' }), new AbortController().signal, () => {})
    expect(out).toContain(relPath('src', 'a.txt'))
    expect(out).toContain(relPath('src', 'nested', 'b.txt'))
    expect(out).not.toContain(relPath('node_modules', 'pkg', 'c.txt'))
    expect(out).not.toContain(relPath('.git', 'internal.txt'))
    expect(out).not.toContain('.env')
    expect(out).not.toContain(relPath('secrets', 'key.txt'))
    expect(out).not.toContain(relPath('dist', 'bundle.txt'))
  })

  it('include_ignored 解除默认忽略名单与隐藏过滤（AC-17 walk 侧；敏感不解除）', async () => {
    const root = fixture({
      'src/a.txt': 'NEEDLE\n',
      'node_modules/pkg/c.txt': 'NEEDLE\n',
      '.git/internal.txt': 'NEEDLE\n',
      '.env': 'NEEDLE\n',
      'secrets/key.txt': 'NEEDLE\n'
    })
    const out = await grepFallbackJs(root, root, 'NEEDLE', args({ outputMode: 'files_with_matches', includeIgnored: true }), new AbortController().signal, () => {})
    expect(out).toContain(relPath('node_modules', 'pkg', 'c.txt'))
    expect(out).toContain(relPath('.git', 'internal.txt'))
    expect(out).not.toContain('.env')
    expect(out).not.toContain(relPath('secrets', 'key.txt'))
  })

  it('目录内 symlink/junction 指向敏感位置时内容不可见（AC-13/AC-13b）', async () => {
    // Windows junction 不需要特权，始终验证（AC-13b）；非 Windows 需 symlink 能力（AC-13）
    if (process.platform !== 'win32' && !(await canCreateSymlinks())) return
    const root = fixture({ 'src/a.txt': 'NEEDLE\n' })
    const outside = fs.mkdtempSync(path.join(path.dirname(root), 'sa-grep-sensitive-target-'))
    roots.push(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'NEEDLE-SECRET\n')
    await fs.promises.symlink(outside, path.join(root, 'src', 'slink'), process.platform === 'win32' ? 'junction' : 'dir')
    const out = await grepFallbackJs(root, root, 'NEEDLE', args({ outputMode: 'files_with_matches' }), new AbortController().signal, () => {})
    expect(out).toContain(relPath('src', 'a.txt'))
    expect(out).not.toContain('slink')
    expect(out).not.toContain('secret.txt')
  })
})

describe('I3：clampLine 显示列宽口径（§7.11 子项 2，AC-45 walk 侧）', () => {
  it('中文行按 2 列/字计：200 汉字（400 列）超 300 列即截断（旧字符数口径 500 不会截断——口径区分点）', async () => {
    const root = fixture({ 'cn.txt': `${'汉'.repeat(200)}NEEDLE\n` })
    const out = await grepFallbackJs(root, root, 'NEEDLE', args({ outputMode: 'content' }), new AbortController().signal, () => {})
    expect(out).toContain('[行被截断]')
    // 行首 300 显示列 ≈ 150 汉字，NEEDLE 在行尾应被截掉
    expect(out).not.toContain('NEEDLE')
  })

  it('ASCII 300 列边界：290 列不截断、310 列截断', async () => {
    const root = fixture({ 'a.txt': `${'x'.repeat(290)}NEEDLE\n`, 'b.txt': `${'y'.repeat(310)}NEEDLE\n` })
    const out = await grepFallbackJs(root, root, 'NEEDLE', args({ outputMode: 'content' }), new AbortController().signal, () => {})
    expect(out).toContain('x'.repeat(290) + 'NEEDLE')
    expect(out).toContain('[行被截断]')
  })
})
