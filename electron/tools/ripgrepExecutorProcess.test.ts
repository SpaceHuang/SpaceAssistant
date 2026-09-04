import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import { grepWithRg, type GrepExecArgs } from './builtinExecutors'

const args = (overrides: Partial<GrepExecArgs> = {}): GrepExecArgs => ({ outputMode: 'content', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100, ...overrides })

async function createFixture(root: string): Promise<string> {
  const fixture = path.join(root, 'rg-fixture.cjs')
  await fs.writeFile(fixture, `
const a = process.argv.slice(2)
if (a.includes('--fixture-sleep')) setTimeout(() => {}, 30000)
const pattern = a[a.indexOf('--regexp') + 1]
if (pattern === '[') process.exit(2)
const file = a[a.length - 1]
if (pattern === 'Needle') process.stdout.write(file + ':1:Needle\\n')
`, 'utf8')
  return fixture
}

const fixtureSpawn = (fixture: string) => (_binary: string, rgArgs: string[], options: Parameters<typeof spawn>[2]) =>
  spawn(process.execPath, [fixture, ...rgArgs], options)

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

  it('区分缺失二进制，并且进程错误只结算一次', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-process-error-'))
    const result = await grepWithRg(path.join(root, 'missing-rg'), root, root, 'Needle', args(), 5000, new AbortController().signal, () => undefined)
    expect(result).toEqual({ kind: 'unavailable', reason: 'missing' })
    await fs.rm(root, { recursive: true, force: true })
  })
})
