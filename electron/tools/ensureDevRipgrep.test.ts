import { describe, expect, it, vi } from 'vitest'
import {
  decideEnsureOutcome,
  ensureCurrentPlatformRipgrep,
  resolveEnsureTarget,
} from '../../scripts/ensure-dev-ripgrep.mjs'

// Phase 0(方案 §3.7):dev 前置「确保当前平台 rg 就绪」。
// 脚本本体是 .mjs CLI,测试只覆盖其导出的纯函数;「失败不阻塞 dev」由
// decideEnsureOutcome 的判定结果承载(告警 + exit 0),不做子进程 fixture。

describe('ensure-dev-ripgrep:resolveEnsureTarget', () => {
  it('支持面内平台返回 manifest target key', () => {
    expect(resolveEnsureTarget('win32', 'x64')).toBe('win32-x64')
    expect(resolveEnsureTarget('darwin', 'x64')).toBe('darwin-x64')
    expect(resolveEnsureTarget('darwin', 'arm64')).toBe('darwin-arm64')
  })

  it('不在支持面(如 linux)返回 null 且不抛错', () => {
    expect(resolveEnsureTarget('linux', 'x64')).toBeNull()
    expect(resolveEnsureTarget('win32', 'arm64')).toBeNull()
    expect(resolveEnsureTarget('sunos', 'x64')).toBeNull()
  })
})

describe('ensure-dev-ripgrep:ensureCurrentPlatformRipgrep', () => {
  it('只以当前平台 target 调用 prepareTarget(防回归到三平台全下)', async () => {
    const prepareTarget = vi.fn(async () => 'staging/rg.exe')
    const outcome = await ensureCurrentPlatformRipgrep({ prepareTarget, platform: 'win32', arch: 'x64' })
    expect(prepareTarget).toHaveBeenCalledTimes(1)
    expect(prepareTarget).toHaveBeenCalledWith('win32-x64')
    expect(outcome).toMatchObject({ ok: true, reason: 'ready', target: 'win32-x64' })
  })

  it('不在支持面时不调用 prepareTarget,返回 unsupported', async () => {
    const prepareTarget = vi.fn(async () => 'staging/rg')
    const outcome = await ensureCurrentPlatformRipgrep({ prepareTarget, platform: 'linux', arch: 'x64' })
    expect(prepareTarget).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: false, reason: 'unsupported', target: null })
  })

  it('prepareTarget 抛错时不向上抛,返回 prepare_failed(断网/代理拦截场景)', async () => {
    const prepareTarget = vi.fn(async () => {
      throw new Error('network unreachable')
    })
    const outcome = await ensureCurrentPlatformRipgrep({ prepareTarget, platform: 'win32', arch: 'x64' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('prepare_failed')
    expect(outcome.target).toBe('win32-x64')
    expect(outcome.error).toBeInstanceOf(Error)
  })
})

describe('ensure-dev-ripgrep:decideEnsureOutcome(失败不阻塞)', () => {
  it('成功 → 无告警、放行', () => {
    const decision = decideEnsureOutcome({ ok: true, reason: 'ready', target: 'win32-x64', error: null })
    expect(decision.exitCode).toBe(0)
    expect(decision.warn).toBeNull()
  })

  it('准备失败 → 告警含 prepare:rg 指引与错误原因,仍放行(exit 0)', () => {
    const decision = decideEnsureOutcome({
      ok: false,
      reason: 'prepare_failed',
      target: 'win32-x64',
      error: new Error('network unreachable'),
    })
    expect(decision.exitCode).toBe(0)
    expect(decision.warn).toContain('prepare:rg')
    expect(decision.warn).toContain('network unreachable')
  })

  it('平台不支持 → 说明性告警(不给出 prepare:rg 误导),仍放行', () => {
    const decision = decideEnsureOutcome({ ok: false, reason: 'unsupported', target: null, error: null })
    expect(decision.exitCode).toBe(0)
    expect(decision.warn).toBeTruthy()
    expect(decision.warn).not.toContain('prepare:rg')
  })
})
