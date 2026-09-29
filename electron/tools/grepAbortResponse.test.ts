import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { grepWithRg, type GrepExecArgs } from './builtinExecutors'
import type { ProcessKiller } from '../shell/processSupervisor'

// Phase 1(方案 §2.5):grep 终止纪律。
// - T-A1/T-A2/T-A3/T-A4/T-A6:中止 → 树杀升级 + 强制结算兜底,Promise 必有界 settle;
// - killer 缝(适配二)是前提:processTreeKiller 的强杀节奏是 spawnUtil 模块常量,
//   不可注入,故测试注入可控 stub,把「进程拒绝退出」收敛到缝上;
// - T-A7(detached 静态门禁)在 toolReliabilityGuards.test.ts。

const args = (overrides: Partial<GrepExecArgs> = {}): GrepExecArgs => ({ outputMode: 'content', ignoreCase: false, showLineNumber: true, multiline: false, headLimit: 100, ...overrides })

async function createFixture(root: string): Promise<string> {
  const fixture = path.join(root, 'rg-abort-fixture.cjs')
  await fs.writeFile(fixture, `
const a = process.argv.slice(2)
if (a.includes('--fixture-ignore-sigterm')) process.on('SIGTERM', () => {})
if (a.includes('--fixture-sleep')) {
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
  setTimeout(() => {}, 30000)
} else {
  process.stdout.write('hit:1:Needle\\n')
}
`, 'utf8')
  return fixture
}

const fixtureSpawn = (fixture: string) => (_binary: string, rgArgs: string[], options: Parameters<typeof spawn>[2]) =>
  spawn(process.execPath, [fixture, ...rgArgs], options)

// Windows:fixture 进程退出与 cwd 释放是异步的,rm 需容忍短暂 EBUSY
async function rmRoot(root: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    try {
      await fs.rm(root, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

/** 从不杀进程的 killer stub:模拟「终止请求发了但进程不退出」(close 永不触发)。 */
function neverKillingKiller() {
  const terminate = vi.fn(async () => ({ signal: 'SIGTERM' as string | null, verified: true }))
  const killer: ProcessKiller = { terminate }
  return { killer, terminate }
}

// Unix 专用:SIGTERM 可被忽略,「强杀升级」只在非 Windows 平台可观测(Windows kill = TerminateProcess)
const itUnix = it.skipIf(process.platform === 'win32')

describe('grep 终止纪律(方案 Phase 1)', () => {  it('T-A1:abort 后进程正常退出 → cancelled + terminated: graceful', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-abort-1-'))
    const binary = await createFixture(root)
    const controller = new AbortController()
    const pending = grepWithRg(binary, root, root, 'Needle', { ...args(), glob: '--fixture-sleep' }, 30000, controller.signal, () => undefined, fixtureSpawn(binary))
    setTimeout(() => controller.abort(), 20)
    const started = Date.now()
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', terminated: 'graceful' })
    expect(Date.now() - started).toBeLessThan(10_000)
    await rmRoot(root)
  })

  it('T-A2:abort 后进程拒绝退出(killer 不生效)→ 兜底强制结算 forced,且有界', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-abort-2-'))
    const binary = await createFixture(root)
    const { killer } = neverKillingKiller()
    const controller = new AbortController()
    const pending = grepWithRg(binary, root, root, 'Needle', { ...args(), glob: '--fixture-sleep' }, 30000, controller.signal, () => undefined, fixtureSpawn(binary), killer)
    setTimeout(() => controller.abort(), 20)
    const started = Date.now()
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', partialOutput: '', terminated: 'forced' })
    // 结算上界 = graceMs + slackMs(约 2s);给 CI 留裕量
    expect(Date.now() - started).toBeLessThan(10_000)
    await rmRoot(root)
  })

  it('T-A3:abort 与 timeout 叠加 → 终态归属 cancelled(先到者优先)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-abort-3-'))
    const binary = await createFixture(root)
    const controller = new AbortController()
    const pending = grepWithRg(binary, root, root, 'Needle', { ...args(), glob: '--fixture-sleep' }, 250, controller.signal, () => undefined, fixtureSpawn(binary))
    setTimeout(() => controller.abort(), 20)
    await expect(pending).resolves.toEqual({ kind: 'cancelled', partialOutput: '', terminated: 'graceful' })
    await rmRoot(root)
  })

  it('T-A5:既有回归——success / timeout 终态不破,timeout 带 terminated: graceful', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-abort-5-'))
    const binary = await createFixture(root)
    const run = (pattern: string, timeout: number, glob?: string) =>
      grepWithRg(binary, root, root, pattern, args({ ...(glob ? { glob } : {}) }), timeout, new AbortController().signal, () => undefined, fixtureSpawn(binary))
    await expect(run('Needle', 5000)).resolves.toMatchObject({ kind: 'success' })
    await expect(run('Needle', 250, '--fixture-sleep')).resolves.toMatchObject({ kind: 'timeout', terminated: 'graceful' })
    await rmRoot(root)
  })

  it('T-A4:结算后无残留——fake timers 下超时定时器与兜底定时器均已清空', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-abort-4-'))
    const binary = await createFixture(root)
    const { killer } = neverKillingKiller()
    vi.useFakeTimers()
    try {
      const baselineTimers = vi.getTimerCount()
      const controller = new AbortController()
      const pending = grepWithRg(binary, root, root, 'Needle', { ...args(), glob: '--fixture-sleep' }, 30000, controller.signal, () => undefined, fixtureSpawn(binary), killer)
      controller.abort()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', terminated: 'forced' })
      expect(vi.getTimerCount()).toBe(baselineTimers)
    } finally {
      vi.useRealTimers()
    }
    await rmRoot(root)
  })

  it('T-A6:abort 必须经 ProcessKiller 终止(注入缝被调用、verified 结果被消费)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-abort-6-'))
    const binary = await createFixture(root)
    const { killer, terminate } = neverKillingKiller()
    const onTerminate = vi.fn()
    const controller = new AbortController()
    const pending = grepWithRg(binary, root, root, 'Needle', { ...args(), glob: '--fixture-sleep' }, 30000, controller.signal, () => undefined, fixtureSpawn(binary), killer, undefined, onTerminate)
    setTimeout(() => controller.abort(), 20)
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', terminated: 'forced' })
    expect(terminate).toHaveBeenCalledTimes(1)
    const [, deadlineMs] = terminate.mock.calls[0]!
    expect(typeof deadlineMs).toBe('number')
    expect(deadlineMs).toBeGreaterThan(0)
    // supervisor 结果被消费:verified === true → 上报 treeKillVerified / state=terminated
    expect(onTerminate).toHaveBeenCalledTimes(1)
    expect(onTerminate).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'abort',
      terminated: 'forced',
      treeKillVerified: true,
      terminationState: 'terminated'
    }))
    await rmRoot(root)
  })

  itUnix('Unix:abort 后忽略 SIGTERM 的进程被强杀升级(SIGKILL)真实退出 → graceful', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-grep-abort-unix-'))
    const binary = await createFixture(root)
    const controller = new AbortController()
    const pending = grepWithRg(binary, root, root, 'Needle', { ...args(), glob: '--fixture-ignore-sigterm', outputMode: 'content' }, 30000, controller.signal, () => undefined, fixtureSpawn(binary))
    setTimeout(() => controller.abort(), 20)
    // 无升级时 close 永不触发 → 只能走 forced 兜底;升级生效则 close 在 250ms 强杀后到达 → graceful
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled', terminated: 'graceful' })
    await rmRoot(root)
  })
})
