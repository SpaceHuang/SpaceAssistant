import { describe, expect, it, vi } from 'vitest'
import { RunShellPlanError } from './runShellPlan'
import { planRejectionFromRunShellPlan, RETURNABLE_RUN_SHELL_PLAN_CODES, type PlanRejectionDeps } from './planRejection'
import { DialectRetryBreaker } from '../shell/dialectRetryBreaker'
import { PlanRejectedError } from '../../packages/agent-sdk/src/turn'

const MISMATCH_DETAILS = {
  code: 'SHELL_DIALECT_MISMATCH', detectedSyntax: 'windows-cmd', expectedDialect: 'windows-powershell',
  shellProfileId: 'windows-powershell', executable: 'powershell.exe',
  signals: ['cmd-operator'], hints: ['命令混入了 cmd 语法，请改写为 PowerShell 等价命令']
}

function mismatchError(): RunShellPlanError {
  return new RunShellPlanError('SHELL_DIALECT_MISMATCH', 'SHELL_DIALECT_MISMATCH', { ...MISMATCH_DETAILS })
}

function deps(): PlanRejectionDeps & { breaker: DialectRetryBreaker; log: ReturnType<typeof vi.fn> } {
  return { breaker: new DialectRetryBreaker(), log: vi.fn() }
}

describe('planRejectionFromRunShellPlan（§4.3/§4.4：转换层 record + 台账 + 提示升级）', () => {
  it('SHELL_DIALECT_MISMATCH 转换为 PlanRejectedError，JSON 携带 caseId 与固定字段', () => {
    const { breaker, log } = deps()
    const rejected = planRejectionFromRunShellPlan(mismatchError(), { sessionId: 's1', requestId: 'r1', toolUseId: 't1', command: 'where.exe a; where.exe b' }, { breaker, log })
    expect(rejected).toBeInstanceOf(PlanRejectedError)
    const parsed = JSON.parse(rejected!.userMessage) as Record<string, unknown>
    expect(parsed).toMatchObject({
      code: 'SHELL_DIALECT_MISMATCH', caseId: 'SHELL-DIALECT-001',
      detectedSyntax: 'windows-cmd', expectedDialect: 'windows-powershell',
      shellProfileId: 'windows-powershell', signals: ['cmd-operator']
    })
    expect(Array.isArray(parsed.hints)).toBe(true)
  })

  it('第 1 次错配如实字段化 retryCount/retryExhausted，同一对象写入 shell.exec.plan_failed 台账（A-8）', () => {
    const { breaker, log } = deps()
    const context = { sessionId: 's1', requestId: 'r1', toolUseId: 't1', command: 'where.exe a; where.exe b' }
    const rejected = planRejectionFromRunShellPlan(mismatchError(), context, { breaker, log })!
    const parsed = JSON.parse(rejected.userMessage) as Record<string, unknown>
    expect(parsed).toMatchObject({ retryCount: 1, retryExhausted: false })
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('error', 'shell.exec.plan_failed', expect.objectContaining({
      requestId: 'r1', sessionId: 's1', toolUseId: 't1',
      shell: 'windows-powershell', errorCode: 'SHELL_DIALECT_MISMATCH', caseId: 'SHELL-DIALECT-001',
      signals: ['cmd-operator'], retryCount: 1, retryExhausted: false
    }))
    const logged = log.mock.calls[0]?.[2] as Record<string, unknown>
    expect(typeof logged.commandFingerprint).toBe('string')
    expect(logged.commandFingerprint).not.toContain('where.exe')
  })

  it('第 2 次同款错配提示升级（给出改写形态）且不阻断（A-2，D-8）', () => {
    const { breaker, log } = deps()
    const context = { sessionId: 's1', requestId: 'r1', toolUseId: 't1', command: 'where.exe a; where.exe b' }
    const first = planRejectionFromRunShellPlan(mismatchError(), context, { breaker, log })!
    const firstHints = (JSON.parse(first.userMessage) as { hints: string[] }).hints
    const second = planRejectionFromRunShellPlan(mismatchError(), context, { breaker, log })!
    const parsedSecond = JSON.parse(second.userMessage) as { hints: string[]; retryCount: number; retryExhausted: boolean }
    expect(parsedSecond.retryCount).toBe(2)
    expect(parsedSecond.retryExhausted).toBe(true)
    expect(parsedSecond.hints).not.toEqual(firstHints)
    const escalatedText = parsedSecond.hints.join(' ')
    expect(escalatedText).toContain('Get-Command')
    expect(log).toHaveBeenLastCalledWith('error', 'shell.exec.plan_failed', expect.objectContaining({ retryCount: 2, retryExhausted: true }))
  })

  it('命令改写成功（clearOnSuccess）后计数归零（可恢复性断言）', () => {
    const { breaker, log } = deps()
    const context = { sessionId: 's1', requestId: 'r1', toolUseId: 't1', command: 'where.exe a; where.exe b' }
    planRejectionFromRunShellPlan(mismatchError(), context, { breaker, log })
    planRejectionFromRunShellPlan(mismatchError(), context, { breaker, log })
    breaker.clearOnSuccess('s1', 'windows-powershell')
    const after = planRejectionFromRunShellPlan(mismatchError(), context, { breaker, log })!
    expect((JSON.parse(after.userMessage) as { retryCount: number }).retryCount).toBe(1)
  })

  it('非方言类计划码不产生 retry 字段，也走台账', () => {
    const { breaker, log } = deps()
    const error = new RunShellPlanError('SHELL_PLAN_INVALID', 'SHELL_LEGACY_CONFIG_UNSUPPORTED', { reason: 'unsupported' })
    const rejected = planRejectionFromRunShellPlan(error, { sessionId: 's1', requestId: 'r1', toolUseId: 't1', command: 'x' }, { breaker, log })!
    const parsed = JSON.parse(rejected.userMessage) as Record<string, unknown>
    expect(parsed).toMatchObject({ code: 'SHELL_PLAN_INVALID', caseId: 'SHELL-PLAN-001' })
    expect(parsed.retryCount).toBeUndefined()
    expect(parsed.retryExhausted).toBeUndefined()
    expect(log).toHaveBeenCalledWith('error', 'shell.exec.plan_failed', expect.objectContaining({
      errorCode: 'SHELL_PLAN_INVALID', caseId: 'SHELL-PLAN-001'
    }))
    expect(log.mock.calls[0]?.[2]).not.toHaveProperty('signals')
  })

  it('白名单集合与 fatal 边界（A-3）', () => {
    expect(RETURNABLE_RUN_SHELL_PLAN_CODES.has('SHELL_DIALECT_MISMATCH')).toBe(true)
    expect(RETURNABLE_RUN_SHELL_PLAN_CODES.has('SHELL_PLAN_INVALID')).toBe(true)
    expect(RETURNABLE_RUN_SHELL_PLAN_CODES.has('SHELL_INTERACTIVE_TTY_REQUIRED')).toBe(true)
    expect(RETURNABLE_RUN_SHELL_PLAN_CODES.has('SHELL_TUI_UNDETECTABLE')).toBe(true)
    expect(RETURNABLE_RUN_SHELL_PLAN_CODES.has('SHELL_EXECUTABLE_UNAVAILABLE')).toBe(false)
    const outside = planRejectionFromRunShellPlan(
      new RunShellPlanError('SHELL_EXECUTABLE_UNAVAILABLE', 'SHELL_EXECUTABLE_UNAVAILABLE', { executable: 'x' }),
      {}, deps()
    )
    expect(outside).toBeUndefined()
  })
})
