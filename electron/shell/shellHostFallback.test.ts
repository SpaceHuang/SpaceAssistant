import { describe, expect, it } from 'vitest'
import { isHostInitFailureCode, planHostFallback, shouldAttemptHostDegrade } from './shellHostFallback'

// ===== P0-C 宿主降级链：纯函数决策（§7.1 #4/#5/#6）=====

describe('isHostInitFailureCode（降级触发条件）', () => {
  it('仅 0xFFFF0000 与 0xC0000142 触发', () => {
    expect(isHostInitFailureCode(4294901760)).toBe(true)
    expect(isHostInitFailureCode(0xc0000142)).toBe(true)
    expect(isHostInitFailureCode(0xc000013a)).toBe(false)
    expect(isHostInitFailureCode(1)).toBe(false)
    expect(isHostInitFailureCode(2)).toBe(false)
    expect(isHostInitFailureCode(null)).toBe(false)
    expect(isHostInitFailureCode(undefined)).toBe(false)
    expect(isHostInitFailureCode('4294901760')).toBe(false)
  })
})

describe('shouldAttemptHostDegrade（降级触发边界，§7.1 #5）', () => {
  const hostInitFailure = {
    success: false,
    error: 'SHELL_PROCESS_EXIT',
    data: { exitCode: 4294901760, status: 'failed', timedOut: false, interrupted: false }
  }

  it('宿主初始化失败（0xFFFF0000 / 0xC0000142）触发', () => {
    expect(shouldAttemptHostDegrade(hostInitFailure)).toBe(true)
    expect(shouldAttemptHostDegrade({
      ...hostInitFailure,
      data: { ...hostInitFailure.data, exitCode: 0xc0000142 }
    })).toBe(true)
  })

  it('普通非零退出、超时、取消、成功、方言错配均不触发', () => {
    expect(shouldAttemptHostDegrade({
      ...hostInitFailure,
      data: { ...hostInitFailure.data, exitCode: 1 }
    })).toBe(false)
    expect(shouldAttemptHostDegrade({
      ...hostInitFailure,
      error: 'SHELL_TIMEOUT',
      data: { ...hostInitFailure.data, exitCode: null, status: 'timed_out', timedOut: true }
    })).toBe(false)
    expect(shouldAttemptHostDegrade({
      ...hostInitFailure,
      error: 'SHELL_CANCELLED',
      data: { ...hostInitFailure.data, exitCode: null, status: 'cancelled', interrupted: true }
    })).toBe(false)
    expect(shouldAttemptHostDegrade({ success: true, data: { exitCode: 0, status: 'succeeded' } })).toBe(false)
    // plan 层方言错配走 SHELL_DIALECT_MISMATCH，不属宿主失败
    expect(shouldAttemptHostDegrade({ success: false, error: 'SHELL_DIALECT_MISMATCH', data: {} })).toBe(false)
    expect(shouldAttemptHostDegrade({ success: false, error: 'SHELL_SPAWN_ERROR', data: { status: 'spawn_failed' } })).toBe(false)
  })
})

describe('planHostFallback（宿主选择顺序，§7.1 #4）', () => {
  it('顺序 powershell → pwsh → cmd；pwsh 不存在时跳过', () => {
    const all = planHostFallback({
      currentShellId: 'builtin-windows-powershell',
      availability: { 'builtin-windows-powershell': true, 'builtin-windows-pwsh': true, 'builtin-windows-cmd': true },
      command: 'echo ok'
    })
    expect(all).toMatchObject({ kind: 'degrade' })
    if (all.kind === 'degrade') expect(all.profile.id).toBe('builtin-windows-pwsh')

    const skipPwsh = planHostFallback({
      currentShellId: 'builtin-windows-powershell',
      availability: { 'builtin-windows-powershell': true, 'builtin-windows-pwsh': false, 'builtin-windows-cmd': true },
      command: 'echo ok'
    })
    expect(skipPwsh).toMatchObject({ kind: 'degrade' })
    if (skipPwsh.kind === 'degrade') expect(skipPwsh.profile.id).toBe('builtin-windows-cmd')
  })

  it('排除已尝试宿主：powershell 主宿主失败后，链不再回头重试它（§9 重试必须换宿主）', () => {
    const decision = planHostFallback({
      currentShellId: 'builtin-windows-pwsh',
      excludedShellIds: ['builtin-windows-powershell', 'builtin-windows-pwsh'],
      availability: { 'builtin-windows-powershell': true, 'builtin-windows-pwsh': true, 'builtin-windows-cmd': true },
      command: 'echo ok'
    })
    expect(decision).toMatchObject({ kind: 'degrade' })
    if (decision.kind === 'degrade') expect(decision.profile.id).toBe('builtin-windows-cmd')
  })

  it('全部候选方言不兼容 → exhausted 结构化结果，不硬跑（§7.1 #6）', () => {
    const decision = planHostFallback({
      currentShellId: 'builtin-windows-powershell',
      availability: { 'builtin-windows-powershell': true, 'builtin-windows-pwsh': false, 'builtin-windows-cmd': true },
      command: 'Write-Output ok'
    })
    expect(decision.kind).toBe('exhausted')
    if (decision.kind === 'exhausted') {
      expect(decision.incompatible.map((c) => c.id)).toEqual(['builtin-windows-cmd'])
      expect(decision.incompatible[0]?.signals.length).toBeGreaterThan(0)
    }
  })

  it('无可用候选 → no-candidates', () => {
    const decision = planHostFallback({
      currentShellId: 'builtin-windows-powershell',
      availability: { 'builtin-windows-powershell': true, 'builtin-windows-pwsh': false, 'builtin-windows-cmd': false },
      command: 'echo ok'
    })
    expect(decision).toEqual({ kind: 'no-candidates' })
  })
})
