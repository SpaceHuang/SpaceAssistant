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
    // 产品目标 profile 由宿主平台决定：Windows 固定 Windows PowerShell，其余平台为 POSIX Bash。
    expect(prepared.profile.dialect).toBe(process.platform === 'win32' ? 'windows-powershell' : 'posix-bash')
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

  it('确认等待期间 outputMode 改变仍按冻结快照重验证', async () => {
    const prepared = await planRunShellExecution({ command: 'echo frozen-mode' }, {
      ...ctx,
      shellConfig: { ...ctx.shellConfig, outputMode: 'terminal' }
    })
    await expect(revalidatePreparedShellExecution(prepared, {
      shellConfig: { ...ctx.shellConfig, outputMode: 'plain' }
    })).resolves.toBeUndefined()
    expect(prepared.shellOutputMode).toBe('terminal')
    expect(prepared.spawnStdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it.each([
    ['less README.md', 'less'],
    ['env sudo vim file.txt', 'vim'],
    ['command htop', 'htop']
  ])('命令位 TUI %s 返回结构化命中 %s', async (command, program) => {
    await expect(planRunShellExecution({ command }, ctx)).rejects.toMatchObject({
      code: 'SHELL_INTERACTIVE_TTY_REQUIRED',
      details: { tuiMatch: { program } }
    })
  })

  it('二次解释无法静态解析时返回不可检测原因', async () => {
    await expect(planRunShellExecution({ command: "bash -c '$CMD less'" }, ctx)).rejects.toMatchObject({
      code: 'SHELL_TUI_UNDETECTABLE',
      details: { tuiUndetectable: { reason: 'unsupported-wrapper' } }
    })
  })

  it('普通文件名与管道重定向不会误判为 TUI', async () => {
    await expect(planRunShellExecution({ command: 'cat htop-report.md | grep less > out.txt' }, ctx)).resolves.toMatchObject({ command: 'cat htop-report.md | grep less > out.txt' })
  })
})
