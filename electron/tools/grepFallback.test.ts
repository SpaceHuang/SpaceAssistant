import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { grepFallbackJs, type GrepExecArgs } from './builtinExecutors'

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
