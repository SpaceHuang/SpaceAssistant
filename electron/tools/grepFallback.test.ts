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

  it('supports multiline matching and count output', async () => {
    const root = fixture({ 'a.txt': 'alpha\nbeta\nalpha beta\n' })
    const multiline = await grepFallbackJs(root, root, 'alpha\\nbeta', args({ multiline: true }), new AbortController().signal, () => {})
    expect(multiline).toContain('a.txt:1:alpha\\nbeta')
    const count = await grepFallbackJs(root, root, 'alpha', args({ outputMode: 'count' }), new AbortController().signal, () => {})
    expect(count).toContain('a.txt:2')
    expect(count).toContain('共 2 处匹配')
  })

  it('respects head limit and treats oversized and binary files as non-results', async () => {
    const root = fixture({ 'a.txt': 'needle\nneedle\n', 'large.txt': 'needle'.repeat(200_000), 'binary.bin': '\u0000needle' })
    const out = await grepFallbackJs(root, root, 'needle', args({ headLimit: 1 }), new AbortController().signal, () => {})
    expect(out).toContain('[共 1 条匹配')
    expect(out).not.toContain('large.txt')
    expect(out).not.toContain('binary.bin')
  })
})
