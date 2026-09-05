import { describe, expect, it } from 'vitest'
import { normalizeShellConfigForPlatform, planRunShellExecution, revalidatePreparedShellExecution, RunShellPlanError, shellConfigRevision } from './runShellPlan'

const ctx = {
  workDir: process.cwd(),
  userDataDir: process.cwd(),
  shellConfig: { enabled: true, shellDefaultTimeoutSec: 12, maxInlineOutputBytes: 4096 }
}

describe('planRunShellExecution', () => {
  it('Windows 旧 PowerShell 配置在 plan 与 revalidate 中使用同一归一化 revision', () => {
    const legacy = { enabled: true, executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }
    const normalized = normalizeShellConfigForPlatform(legacy, 'win32')
    expect(normalized?.argsPrefix).toBeUndefined()
    expect(normalized?.executable).toBe('powershell.exe')
    expect(shellConfigRevision(legacy, 'win32')).toBe(shellConfigRevision(normalized, 'win32'))
  })

  it('生成冻结的 profile/spawn/cwd/env prepared snapshot，不启动进程', async () => {
    const prepared = await planRunShellExecution({ command: 'echo planned', timeout: 3 }, ctx)
    expect(prepared.command).toBe('echo planned')
    expect(prepared.timeoutMs).toBe(3000)
    expect(prepared.ioMaxBytes).toBe(4096)
    expect(prepared.profile.dialect).toBe('posix-bash')
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(prepared.planDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('配置无效在计划阶段返回结构化错误', async () => {
    await expect(planRunShellExecution({ command: 'echo bad' }, {
      ...ctx,
      shellConfig: { enabled: true, shellDefaultTimeoutSec: -1 }
    })).rejects.toMatchObject<RunShellPlanError>({ code: 'SHELL_PLAN_INVALID' })
  })

  it('确认等待期间依赖快照变化会阻止执行并返回 PLAN_STALE', async () => {
    const prepared = await planRunShellExecution({ command: 'echo stale' }, ctx)
    const stale = {
      ...prepared,
      pathSnapshot: { ...prepared.pathSnapshot, [prepared.cwd]: 'changed-realpath' }
    }
    await expect(revalidatePreparedShellExecution(stale)).rejects.toMatchObject({ code: 'PLAN_STALE' })
  })

  it('确认等待期间 shell 配置变化会阻止执行并返回 PLAN_STALE', async () => {
    const prepared = await planRunShellExecution({ command: 'echo config-stale' }, ctx)
    await expect(revalidatePreparedShellExecution(prepared, {
      shellConfig: { ...ctx.shellConfig, maxInlineOutputBytes: 8192 }
    })).rejects.toMatchObject({ code: 'PLAN_STALE' })
  })

  it('确认等待期间 policy revision 变化会阻止执行并返回 PLAN_STALE', async () => {
    const prepared = await planRunShellExecution({ command: 'echo policy-stale' }, {
      ...ctx,
      policyRevision: 'policy-v1'
    })
    await expect(revalidatePreparedShellExecution(prepared, {
      shellConfig: ctx.shellConfig,
      policyRevision: 'policy-v2'
    })).rejects.toMatchObject({ code: 'PLAN_STALE' })
  })
})
