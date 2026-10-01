import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  GREP_DEFAULT_IGNORES,
  grepSensitiveExcludes,
  planGrepInvocation,
  formatGrepNoMatchOutput,
  type GrepScope,
} from './grepScope'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-grep-scope-'))
}

describe('grepSensitiveExcludes（两引擎共用同一份规则生成，C1 配套硬要求 2）', () => {
  it('覆盖 .env / .env.* / secrets/ 三类敏感形态', () => {
    const globs = grepSensitiveExcludes()
    expect(globs).toContain('!**/.env')
    expect(globs).toContain('!**/.env.*')
    expect(globs).toContain('!**/secrets/**')
  })
})

describe('planGrepInvocation（R6 三形态 × 三类条目语义）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function setupRoot(): string {
    const root = tempDir()
    dirs.push(root)
    for (const name of ['node_modules', 'dist', '.git', '.cursor']) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
    }
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
    fs.writeFileSync(path.join(root, 'app.ts'), 'export {}')
    return root
  }

  it('T-R6-1：默认搜索——名单成员计入 skipped，非隐藏成员追加名单 glob，不传 --hidden，追加敏感 glob', () => {
    const root = setupRoot()
    const plan = planGrepInvocation({ workDir: root, searchPath: path.resolve(root), args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 } })
    expect(plan.hidden).toBe(false)
    expect(plan.explicitSensitiveHit).toBe(false)
    expect(plan.sensitiveExcludes.length).toBeGreaterThan(0)
    const skipNames = plan.scope.skipped.map((s) => s.name)
    expect(skipNames).toEqual(expect.arrayContaining(['node_modules', 'dist', '.git', '.cursor']))
    expect(plan.scope.skipped.every((s) => !s.explicit)).toBe(true)
    expect(plan.scope.skippedCount).toBe(plan.scope.skipped.length)
  })

  it('T-R6-2：显式路径指向非隐藏成员（node_modules 内部）——解除该成员排除，skipped 不含它', () => {
    const root = setupRoot()
    const inside = path.join(root, 'node_modules', 'pkg')
    fs.mkdirSync(inside, { recursive: true })
    const plan = planGrepInvocation({ workDir: root, searchPath: inside, args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 } })
    expect(plan.scope.skipped.some((s) => s.name === 'node_modules')).toBe(false)
    expect(plan.scope.skipped.some((s) => s.name === '.git')).toBe(true)
    expect(plan.ignoreGlobs.filter((g) => g.includes('node_modules'))).toEqual([])
  })

  it('T-R6-4：显式路径指向隐藏成员（.git 内部）——传 --hidden 且解除该成员 glob；默认（无 path）不传 --hidden', () => {
    const root = setupRoot()
    const insideGit = path.join(root, '.git', 'objects')
    fs.mkdirSync(insideGit, { recursive: true })
    const explicit = planGrepInvocation({ workDir: root, searchPath: insideGit, args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 } })
    expect(explicit.hidden).toBe(true)
    expect(explicit.ignoreGlobs.filter((g) => g.includes('.git'))).toEqual([])

    const bySwitch = planGrepInvocation({ workDir: root, searchPath: path.resolve(root), args: { includeIgnored: true, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 } })
    expect(bySwitch.hidden).toBe(true)
    expect(bySwitch.ignoreGlobs).toEqual([])
  })

  it('T-R6-6：敏感文件 .env——默认与 include_ignored 均不搜（敏感 glob 存在）；显式点名该文件则搜（无敏感 glob）且明示命中', () => {
    const root = setupRoot()
    const envFile = path.join(root, '.env')

    const byDefault = planGrepInvocation({ workDir: root, searchPath: path.resolve(root), args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 } })
    expect(byDefault.sensitiveExcludes.length).toBeGreaterThan(0)

    const withSwitch = planGrepInvocation({ workDir: root, searchPath: path.resolve(root), args: { includeIgnored: true, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 } })
    // 批量开关不解除敏感路径（意图强度判据）
    expect(withSwitch.sensitiveExcludes.length).toBeGreaterThan(0)

    const explicit = planGrepInvocation({ workDir: root, searchPath: envFile, args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 } })
    expect(explicit.explicitSensitiveHit).toBe(true)
    expect(explicit.sensitiveExcludes).toEqual([])
  })

  it('T-R6-6：显式点名敏感目录内部（secrets/x）同样解除且明示', () => {
    const root = setupRoot()
    const secretsDir = path.join(root, 'secrets')
    fs.mkdirSync(secretsDir, { recursive: true })
    const plan = planGrepInvocation({ workDir: root, searchPath: path.join(secretsDir, 'key.txt'), args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 } })
    expect(plan.explicitSensitiveHit).toBe(true)
  })
})

describe('formatGrepNoMatchOutput（R6：no_match 必带范围）', () => {
  it('无跳过时保持简短并含 searched root', () => {
    const scope: GrepScope = { root: 'src', engine: 'ripgrep', skipped: [], skippedCount: 0, truncated: false }
    const out = formatGrepNoMatchOutput(scope)
    expect(out).toContain('No matches found')
    expect(out).toContain('src')
    expect(out).not.toContain('skipped')
  })

  it('有跳过时必须列出范围与提示（不得裸 No matches found）', () => {
    const scope: GrepScope = {
      root: '.',
      engine: 'ripgrep',
      skipped: [{ name: 'node_modules', explicit: false }, { name: '.git', explicit: false }],
      skippedCount: 2,
      truncated: false
    }
    const out = formatGrepNoMatchOutput(scope)
    expect(out).toContain('No matches found')
    expect(out).toContain('skipped 2 items')
    expect(out).toContain('node_modules')
    expect(out).toContain('.git')
    expect(out).toContain('may contain matches')
  })

  it('敏感跳过标注原因（sensitive 类）', () => {
    const scope: GrepScope = {
      root: '.',
      engine: 'walk',
      skipped: [{ name: '.env', explicit: false, sensitive: true }],
      skippedCount: 1,
      truncated: false
    }
    const out = formatGrepNoMatchOutput(scope)
    expect(out).toContain('.env')
    expect(out).toContain('sensitive')
  })
})

describe('D1/D2（评审 2026-09-28）：大小写变体与嵌套点名', () => {
  const dirs2: string[] = []
  afterEach(() => {
    for (const d of dirs2.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('D2：嵌套成员点名（sub/node_modules/pkg）解除 node_modules 排除，skipped 不含它', () => {
    const root = tempDir()
    dirs2.push(root)
    fs.mkdirSync(path.join(root, 'sub', 'node_modules', 'pkg'), { recursive: true })
    const plan = planGrepInvocation({
      workDir: root,
      searchPath: path.join(root, 'sub', 'node_modules', 'pkg'),
      args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 }
    })
    expect(plan.ignoreGlobs.filter((g) => g.includes('node_modules'))).toEqual([])
    expect(plan.scope.skipped.some((s) => s.name === 'node_modules')).toBe(false)
  })

  it('D2：嵌套隐藏段点名（src/.vite/cache）→ hidden=true', () => {
    const root = tempDir()
    dirs2.push(root)
    fs.mkdirSync(path.join(root, 'src', '.vite', 'cache'), { recursive: true })
    const plan = planGrepInvocation({
      workDir: root,
      searchPath: path.join(root, 'src', '.vite', 'cache'),
      args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 }
    })
    expect(plan.hidden).toBe(true)
  })

  it('D2：未点名成员仍计入 skipped（sub 外层目录存在时 node_modules 仍跳过）', () => {
    const root = tempDir()
    dirs2.push(root)
    fs.mkdirSync(path.join(root, 'sub', 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    const plan = planGrepInvocation({
      workDir: root,
      searchPath: path.join(root, 'sub'),
      args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 }
    })
    expect(plan.scope.skipped.some((s) => s.name === 'node_modules')).toBe(true)
  })

  it('D1：planGrepInvocation 产出的大小写无关标记为真（iglob）', () => {
    const root = tempDir()
    dirs2.push(root)
    const plan = planGrepInvocation({
      workDir: root,
      searchPath: path.resolve(root),
      args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 }
    })
    expect(plan.caseInsensitiveGlobs).toBe(true)
  })
})

describe('planGrepInvocation searchKind（§7.5，C6：单文件不产目录遍历语义）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function setupRoot(): string {
    const root = tempDir()
    dirs.push(root)
    for (const name of ['node_modules', 'dist', '.git']) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
    }
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
    return root
  }

  it("searchKind='file'：skipped 恒空、ignoreGlobs 恒空（§1.4 虚报修复，AC-14/AC-19）", () => {
    const root = setupRoot()
    const file = path.join(root, 'a.txt')
    const plan = planGrepInvocation({
      workDir: root, searchPath: file,
      args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 },
      searchKind: 'file'
    })
    expect(plan.scope.skipped).toEqual([])
    expect(plan.scope.skippedCount).toBe(0)
    expect(plan.ignoreGlobs).toEqual([])
  })

  it("searchKind='file' 且显式点名敏感文件：sensitiveExcludes 仍按 explicitSensitiveHit 语义", () => {
    const root = setupRoot()
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
    const plan = planGrepInvocation({
      workDir: root, searchPath: path.join(root, '.env'),
      args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 },
      searchKind: 'file'
    })
    expect(plan.explicitSensitiveHit).toBe(true)
    expect(plan.sensitiveExcludes).toEqual([])
  })

  it('缺省 searchKind 保持既有目录语义（回归）', () => {
    const root = setupRoot()
    const plan = planGrepInvocation({
      workDir: root, searchPath: root,
      args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 }
    })
    expect(plan.scope.skipped.length).toBeGreaterThan(0)
    expect(plan.ignoreGlobs.length).toBeGreaterThan(0)
  })
})

describe('searchGitignored → noIgnoreVcs（阶段 G，§7.9 改动 2）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function run(argsOverride: Record<string, unknown>, opts: Record<string, unknown> = {}): { noIgnoreVcs: boolean } & Record<string, unknown> {
    const root = tempDir()
    dirs.push(root)
    return planGrepInvocation({
      workDir: root, searchPath: root,
      args: { includeIgnored: false, outputMode: 'files_with_matches', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100, ...argsOverride },
      ...opts
    }) as never
  }

  it('设置项 searchGitignored: true → noIgnoreVcs: true（AC-34 前置）', () => {
    expect(run({}, { searchGitignored: true }).noIgnoreVcs).toBe(true)
  })

  it('仅 includeIgnored: true → noIgnoreVcs: true（AC-36）', () => {
    expect(run({ includeIgnored: true }).noIgnoreVcs).toBe(true)
  })

  it('二者皆假 → noIgnoreVcs: false（默认行为与改动前逐字一致，AC-33）', () => {
    expect(run({}).noIgnoreVcs).toBe(false)
  })

  it('OR 语义：设置项为「下限」，调用方 includeIgnored 不得收窄', () => {
    expect(run({ includeIgnored: true }, { searchGitignored: true }).noIgnoreVcs).toBe(true)
  })
})

describe('敏感条目明示（阶段 H，§7.10，AC-39~43）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function setupRootWithSensitive(): string {
    const root = tempDir()
    dirs.push(root)
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
    fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=2')
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(root, 'secrets', 'key.txt'), 'SECRET=3')
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
    return root
  }

  const baseArgs = { includeIgnored: false, outputMode: 'files_with_matches' as const, ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100 }

  it('H1：目录模式对根级 .env（file）与 secrets/（directory）产出 sensitive: true 条目（AC-40）', () => {
    const root = setupRootWithSensitive()
    const plan = planGrepInvocation({ workDir: root, searchPath: path.resolve(root), args: baseArgs })
    const sensitive = plan.scope.skipped.filter((s) => s.sensitive)
    expect(sensitive).toHaveLength(3)
    const byName = new Map(sensitive.map((s) => [s.name, s]))
    expect(byName.get('.env')).toMatchObject({ kind: 'file', sensitive: true })
    expect(byName.get('.env.local')).toMatchObject({ kind: 'file', sensitive: true })
    expect(byName.get('secrets')).toMatchObject({ kind: 'directory', sensitive: true })
  })

  it('H1：explicitSensitiveHit=true（显式点名敏感路径）时不产生敏感 skipped 条目（AC-41）', () => {
    const root = setupRootWithSensitive()
    const plan = planGrepInvocation({ workDir: root, searchPath: path.join(root, '.env'), args: baseArgs })
    expect(plan.explicitSensitiveHit).toBe(true)
    expect(plan.scope.skipped.filter((s) => s.sensitive)).toHaveLength(0)
  })

  it('H1：searchKind=file 时 skipped 恒空——敏感统计不破坏 §1.4 修复（AC-42）', () => {
    const root = setupRootWithSensitive()
    const plan = planGrepInvocation({ workDir: root, searchPath: path.join(root, 'a.txt'), args: baseArgs, searchKind: 'file' })
    expect(plan.scope.skipped).toEqual([])
  })

  it('H1：skipped 条目不含 explicit 死字段（§1.6）', () => {
    const root = setupRootWithSensitive()
    const plan = planGrepInvocation({ workDir: root, searchPath: path.resolve(root), args: baseArgs })
    expect(plan.scope.skipped.length).toBeGreaterThan(0)
    expect(plan.scope.skipped.some((s) => 'explicit' in s)).toBe(false)
  })

  it('H3：无匹配文案对敏感条目标注 (sensitive, not searched) 且计数词为 items（AC-40 文本形态）', () => {
    const scope: GrepScope = {
      root: '.',
      engine: 'ripgrep',
      skipped: [
        { name: 'node_modules', kind: 'directory' },
        { name: '.env', kind: 'file', sensitive: true },
        { name: 'secrets', kind: 'directory', sensitive: true }
      ],
      skippedCount: 3,
      truncated: false
    }
    const text = formatGrepNoMatchOutput(scope)
    expect(text).toContain('skipped 3 items:')
    expect(text).toContain('.env (sensitive, not searched)')
    expect(text).toContain('secrets (sensitive, not searched)')
    expect(text).not.toContain('directories:')
  })
})
