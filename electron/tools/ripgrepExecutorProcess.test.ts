import fs from 'fs/promises'
import fsSync from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import {
  createGrepRipgrepUnavailableDiagnostic,
  grepRipgrepUnavailableUserMessage,
  grepWithRg,
  type GrepExecArgs
} from './builtinExecutors'

const args = (overrides: Partial<GrepExecArgs> = {}): GrepExecArgs => ({ outputMode: 'content', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100, ...overrides })

async function createFixture(root: string): Promise<string> {
  const fixture = path.join(root, 'rg-fixture.cjs')
  await fs.writeFile(fixture, `
const a = process.argv.slice(2)
if (a.includes('--fixture-sleep')) setTimeout(() => {}, 30000)
const pattern = a[a.indexOf('--regexp') + 1]
if (pattern === '[') process.exit(2)
const file = a[a.length - 1]
if (pattern === 'BigTruncated') { process.stdout.write('x'.repeat(500 * 1024)); process.stderr.write(Buffer.from([0xe4])); process.exitCode = 2 }
const fs = require('fs')
const content = file === '-' ? fs.readFileSync(0, 'utf8') : fs.statSync(file).isDirectory() ? 'Needle\\nother\\n' : fs.readFileSync(file, 'utf8')
if (pattern === 'Needle' && content.includes('Needle')) {
  if (file === '-' && a.includes('-l')) process.stdout.write('<stdin>\\n')
  else if (file === '-' && a.includes('--count')) process.stdout.write('<stdin>:1\\n')
  else if (file === '-' && a.includes('-C')) process.stdout.write('<stdin>-1-before\\n<stdin>:2:Needle <stdin>:1\\n<stdin>-3-after\\n')
  else if (file === '-' && a.includes('--with-filename')) process.stdout.write('<stdin>:1:Needle <stdin>:1\\n')
  else if (file === '-') process.stdout.write('1:Needle\\n')
  else process.stdout.write(file + ':1:Needle\\n')
}
`, 'utf8')
  return fixture
}

const fixtureSpawn = (fixture: string) => (_binary: string, rgArgs: string[], options: Parameters<typeof spawn>[2]) =>
  spawn(process.execPath, [fixture, ...rgArgs], options)

/**
 * 真随包 rg 二进制定位：从测试文件位置推导仓库根（forks worker 的 process.cwd() 不保证是项目根，
 * 曾导致全部真机用例静默跳过——AC-34/I5 曾因此假绿）。
 * 候选顺序：SA_TEST_RG_BIN 环境变量 → 本 checkout resources → 主 checkout resources（worktree 布局，
 * resources/ripgrep 不入库，仅本地开发便利）。
 */
const findRealRg = (): string | null => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const candidates = [
    process.env.SA_TEST_RG_BIN,
    path.join(repoRoot, 'resources', 'ripgrep', `${process.platform}-${process.arch}`, rgName),
    path.resolve(repoRoot, '..', '..', 'resources', 'ripgrep', `${process.platform}-${process.arch}`, rgName)
  ].filter((c): c is string => Boolean(c))
  return candidates.find((c) => fsSync.existsSync(c)) ?? null
}

describe('bundled ripgrep process contract', () => {
  it('覆盖成功、无匹配和非法正则，不启动第二引擎', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-process-'))
    await fs.writeFile(path.join(root, 'a.txt'), 'Needle\nother\n', 'utf8')
    const binary = await createFixture(root)
    const progress = () => undefined
    const run = (pattern: string, timeout = 5000, signal = new AbortController().signal) => grepWithRg(binary, root, root, pattern, args(), timeout, signal, progress, fixtureSpawn(binary))
    await expect(run('Needle')).resolves.toMatchObject({ kind: 'success' })
    await expect(run('missing')).resolves.toEqual({ kind: 'no_match', output: 'No matches found' })
    await expect(run('[')).resolves.toMatchObject({ kind: 'failed', exitCode: 2 })
    await fs.rm(root, { recursive: true, force: true })
  })

  it('固定句柄 grep 在路径被替换后仍只搜索已批准文件', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-stable-fd-'))
    const file = path.join(root, 'approved.txt')
    await fs.writeFile(file, 'Needle approved\n', 'utf8')
    const fileHandle = await fs.open(file, 'r')
    try {
      await fs.rename(file, `${file}.moved`)
      await fs.writeFile(file, 'attacker replacement\n', 'utf8')
      const binary = await createFixture(root)
      const result = await grepWithRg(binary, root, file, 'Needle', args(), 5000, new AbortController().signal, () => undefined, fixtureSpawn(binary), { fileHandle, platform: process.platform })
      expect(result).toMatchObject({ kind: 'success' })
    } finally {
      await fileHandle.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('Windows 固定句柄 grep 通过 stdin 搜索已打开目标，不重新按路径读取', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-stable-stdin-'))
    const file = path.join(root, 'approved.txt')
    await fs.writeFile(file, 'Needle approved\n', 'utf8')
    try {
      await fs.rename(file, `${file}.moved`)
      await fs.writeFile(file, 'attacker replacement\n', 'utf8')
      const binary = await createFixture(root)
      const run = async (outputMode: GrepExecArgs['outputMode'], context?: number) => {
        const fileHandle = await fs.open(`${file}.moved`, 'r')
        try {
          return await grepWithRg(binary, root, file, 'Needle', args({ outputMode, context }), 5000, new AbortController().signal, () => undefined, fixtureSpawn(binary), { fileHandle, platform: 'win32' })
        } finally {
          await fileHandle.close()
        }
      }
      await expect(run('files_with_matches')).resolves.toEqual({ kind: 'success', output: file })
      await expect(run('count')).resolves.toEqual({ kind: 'success', output: `${file}:1` })
      await expect(run('content')).resolves.toEqual({ kind: 'success', output: `${file}:1:Needle <stdin>:1` })
      await expect(run('content', 1))
        .resolves.toEqual({ kind: 'success', output: `${file}-1-before\n${file}:2:Needle <stdin>:1\n${file}-3-after` })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('超时和取消返回结构化状态', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-process-state-'))
    await fs.writeFile(path.join(root, 'a.txt'), 'Needle\n'.repeat(1000), 'utf8')
    const binary = await createFixture(root)
    const progress = () => undefined
    const aborted = new AbortController(); aborted.abort()
    const run = (timeout: number, signal: AbortSignal) => grepWithRg(binary, root, root, 'Needle', { ...args(), glob: '--fixture-sleep' }, timeout, signal, progress, fixtureSpawn(binary))
    await expect(run(5000, aborted.signal)).resolves.toMatchObject({ kind: 'cancelled' })
    const controller = new AbortController()
    const pending = run(5000, controller.signal)
    setTimeout(() => controller.abort(), 20)
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled' })
    await fs.rm(root, { recursive: true, force: true })
  })

  it('MINOR：stdout 触发截断时 stderr 仍必须 flush（诊断信息不丢）', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-process-truncated-'))
    const binary = await createFixture(root)
    const result = await grepWithRg(binary, root, root, 'BigTruncated', args(), 5000, new AbortController().signal, () => undefined, fixtureSpawn(binary))
    expect(result).toMatchObject({ kind: 'failed', exitCode: 2 })
    // stderr 尾部是领字节（未完成的多字节序列）：stdout 截断不能连带把 stderr 的 flush 一起跳过。
    expect(String((result as { message?: string }).message)).toContain('\uFFFD')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('区分缺失二进制，并且进程错误只结算一次', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-process-error-'))
    const result = await grepWithRg(path.join(root, 'missing-rg'), root, root, 'Needle', args(), 5000, new AbortController().signal, () => undefined)
    expect(result).toEqual({ kind: 'unavailable', reason: 'not_found' })
    await fs.rm(root, { recursive: true, force: true })
  })

  it('开发态不可用时给出准备指引，诊断不包含路径或 pattern', () => {
    const resolved = { source: 'development' as const, platform: 'darwin' as const, arch: 'arm64' }
    const message = grepRipgrepUnavailableUserMessage(resolved, 'not_found')
    expect(message).toContain('npm run prepare:rg -- --target=darwin-arm64')
    expect(message).toContain('新 worktree 首次 npm run dev 会自动准备')
    expect(message).not.toMatch(/pattern|cwd|workdir|(?:\/Users\/|[A-Z]:\\)/i)
    const diagnostic = createGrepRipgrepUnavailableDiagnostic(resolved, 'not_found')
    expect(diagnostic).toBe('source=development;platform=darwin;arch=arm64;status=unavailable;reason=not_found')
    expect(diagnostic).not.toMatch(/pattern|cwd|workdir|path/i)
  })
})

describe('grep 目录递归（E2，rg 路径）', () => {
  it('目录 searchPath 直传 rg（无 openedFile 时），多文件输出原样返回', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-dir-'))
    const binary = await createFixture(root)
    try {
      const captured: string[][] = []
      const spawnDir = (captured: string[][]) => (_binary: string, rgArgs: string[], options: Parameters<typeof spawn>[2]) => {
        captured.push(rgArgs)
        // 模拟 rg 对目录递归的行为：返回两个文件的命中
        const proc = spawn(process.execPath, ['-e', 'process.stdout.write(["sub/a.txt:1:Needle", "sub/b.txt:1:Needle"].join(String.fromCharCode(10)))'], options)
        return proc
      }
      const capturedStore: string[][] = []
      const result = await grepWithRg(binary, root, root, 'Needle', args(), 5000, new AbortController().signal, () => undefined, spawnDir(capturedStore))
      expect(result).toMatchObject({ kind: 'success' })
      if (result.kind === 'success') expect(result.output).toContain('sub/b.txt')
      // 目录搜索根作为 rg 的最后一个位置参数（无 /dev/fd/N、无 '-'）；I6 后 workDir 内传相对形态（根为 '.'）
      const lastArg = capturedStore[0]![capturedStore[0]!.length - 1]
      expect(lastArg).toBe('.')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('真随包 rg：目录递归命中多文件（AC-14，二进制缺失时跳过）', async () => {
    const binary = findRealRg()
    if (!fsSync.existsSync(binary)) return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-real-dir-'))
    try {
      await fs.mkdir(path.join(root, 'sub'), { recursive: true })
      await fs.writeFile(path.join(root, 'a.txt'), 'NEEDLE one\n')
      await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'NEEDLE two\n')
      await fs.writeFile(path.join(root, 'node_modules', 'ignore.txt'), 'NEEDLE three\n').catch(async () => {
        await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
        await fs.writeFile(path.join(root, 'node_modules', 'ignore.txt'), 'NEEDLE three\n')
      })
      const result = await grepWithRg(binary, root, root, 'NEEDLE', args({ outputMode: 'files_with_matches' }), 10000, new AbortController().signal, () => undefined)
      expect(result).toMatchObject({ kind: 'success' })
      if (result.kind === 'success') {
        expect(result.output).toContain('a.txt')
        expect(result.output).toContain(path.join('sub', 'b.txt'))
        // 默认忽略名单内的文件不出现（rg 经 --iglob 排除）
        expect(result.output).not.toContain('ignore.txt')
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

describe('G12：grepSearchGitignored 真机端到端（AC-34/AC-35/AC-36，§6.5 E1：须先建 .git 否则 .gitignore 不生效）', () => {
  it('设置开启：被 .gitignore 忽略的文件出现（AC-34），敏感条目仍排除（AC-35）', async () => {
    const binary = findRealRg()
    if (!binary) return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-gitignored-on-'))
    try {
      await fs.mkdir(path.join(root, '.git'), { recursive: true })
      await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n.env\nsecrets/\n')
      await fs.writeFile(path.join(root, 'tracked.txt'), 'NEEDLE tracked\n')
      await fs.writeFile(path.join(root, 'ignored.txt'), 'NEEDLE ignored\n')
      await fs.writeFile(path.join(root, '.env'), 'NEEDLE secret\n')
      await fs.mkdir(path.join(root, 'secrets'), { recursive: true })
      await fs.writeFile(path.join(root, 'secrets', 'key.txt'), 'NEEDLE secret\n')
      // 实参序列：onProgress(8), spawnProcess(9), openedFile(10), killer(11), onTerminate(12), planOverrides(13)
      const result = await grepWithRg(binary, root, root, 'NEEDLE', args({ outputMode: 'files_with_matches' }), 10000, new AbortController().signal, () => undefined, undefined, undefined, undefined, undefined, { searchGitignored: true })
      expect(result).toMatchObject({ kind: 'success' })
      if (result.kind === 'success') {
        expect(result.output).toContain('tracked.txt')
        expect(result.output).toContain('ignored.txt')
        expect(result.output).not.toContain('.env')
        expect(result.output).not.toContain('secrets')
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('设置关闭：被 .gitignore 忽略的文件不出现（默认行为与改动前逐字一致，AC-33）', async () => {
    const binary = findRealRg()
    if (!binary) return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-gitignored-off-'))
    try {
      await fs.mkdir(path.join(root, '.git'), { recursive: true })
      await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n')
      await fs.writeFile(path.join(root, 'tracked.txt'), 'NEEDLE tracked\n')
      await fs.writeFile(path.join(root, 'ignored.txt'), 'NEEDLE ignored\n')
      const result = await grepWithRg(binary, root, root, 'NEEDLE', args({ outputMode: 'files_with_matches' }), 10000, new AbortController().signal, () => undefined)
      expect(result).toMatchObject({ kind: 'success' })
      if (result.kind === 'success') {
        expect(result.output).toContain('tracked.txt')
        expect(result.output).not.toContain('ignored.txt')
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

describe('I5/I6：rg 侧路径相对化（§7.11 子项 1，AC-47/AC-48）', () => {
  it('workDir 内目录搜索：rg 输出相对路径且无 ./ 前缀（AC-47，与 walk 同形态）', async () => {
    const binary = findRealRg()
    if (!binary) return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-rel-'))
    try {
      await fs.mkdir(path.join(root, 'sub'), { recursive: true })
      await fs.writeFile(path.join(root, 'a.txt'), 'NEEDLE one\n')
      await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'NEEDLE two\n')
      const result = await grepWithRg(binary, root, root, 'NEEDLE', args({ outputMode: 'files_with_matches' }), 10000, new AbortController().signal, () => undefined)
      expect(result).toMatchObject({ kind: 'success' })
      if (result.kind === 'success') {
        fsSync.appendFileSync(path.join(process.cwd(), 'dbg-rel.txt'), JSON.stringify(result.output) + '\n')
        expect(result.output).toContain(path.join('sub', 'b.txt'))
        expect(result.output).not.toContain(root)
        expect(result.output).not.toContain('.\\')
        expect(result.output).not.toContain('./')
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('workDir 外搜索根：rg 输出绝对路径（AC-48）', async () => {
    const binary = findRealRg()
    if (!binary) return
    const inner = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-rel-inner-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-rel-out-'))
    try {
      await fs.writeFile(path.join(outside, 'found.txt'), 'NEEDLE\n')
      const result = await grepWithRg(binary, inner, outside, 'NEEDLE', args({ outputMode: 'files_with_matches' }), 10000, new AbortController().signal, () => undefined)
      expect(result).toMatchObject({ kind: 'success' })
      if (result.kind === 'success') {
        expect(result.output).toContain(path.join(outside, 'found.txt'))
      }
    } finally {
      await fs.rm(inner, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})
