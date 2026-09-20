import { describe, expect, it, vi } from 'vitest'
import { prepareShellExecution, type PreparedShellExecution } from '../shell/preparedShellExecution'
import { logShellAgentEvent } from '../shell/shellAgentLogger'
import { runShellWithHostFallback, SHELL_HOST_DEGRADE_DIALECT_INCOMPATIBLE } from './runShellHostDegrade'
import type { ToolExecutionContext, ToolExecutorResult } from './types'

vi.mock('../shell/shellAgentLogger', () => ({
  logShellAgentEvent: vi.fn()
}))

// ===== P0-C 宿主降级链：执行编排（§5.3 三个约束 + §7.2 降级链路端到端）=====

// 默认命令双方言兼容（powershell 家族与 cmd 均可执行），专测方言边界的用例单独给命令
function makePrepared(command = 'echo ok'): PreparedShellExecution {
  return prepareShellExecution({
    command,
    profile: {
      id: 'builtin-windows-powershell',
      dialect: 'windows-powershell',
      executable: 'powershell.exe',
      outputEncoding: { kind: 'oem', codepage: 936 }
    },
    spawnSpec: { executable: 'powershell.exe', args: ['-NoLogo', '-EncodedCommand', 'QCFB'], shellId: 'builtin-windows-powershell' },
    cwd: 'C:\\work',
    timeoutMs: 30_000,
    ioMaxBytes: 102_400,
    environment: { Path: 'C:\\Windows\\system32', SystemRoot: 'C:\\WINDOWS' },
    facts: { dialect: 'windows-powershell' },
    configRevision: '{"shell":"builtin-windows-powershell"}',
    policyRevision: 'runtime',
    dependencySnapshot: {
      platform: 'win32',
      profileId: 'builtin-windows-powershell',
      executable: 'powershell.exe',
      environmentFingerprint: 'fp-primary'
    },
    pathSnapshot: { 'powershell.exe': 'powershell.exe', 'C:\\work': 'C:\\work' }
  })
}

function makeCtx(): ToolExecutionContext {
  return {
    workDir: 'C:\\work',
    userDataDir: 'C:\\userdata',
    requestId: 'req-1',
    toolUseId: 'tool-1',
    sessionId: 'sess-1',
    sendProgress: vi.fn(),
    signal: new AbortController().signal,
    fileStateCache: {} as never,
    toolsConfig: { enabled: true, allowedTools: [], deniedTools: [] }
  }
}

function hostInitFailure(shellId = 'builtin-windows-powershell'): ToolExecutorResult {
  return {
    success: false,
    error: 'SHELL_PROCESS_EXIT',
    data: {
      exitCode: 4294901760,
      status: 'failed',
      shell: shellId,
      hresult: { code: '0x8009001D', name: 'NTE_PROVIDER_DLL_FAIL', meaning: '加密服务提供程序 DLL 加载或初始化失败', advice: [] }
    },
    duration: 3000
  }
}

function successResult(shellId: string): ToolExecutorResult {
  return { success: true, data: { exitCode: 0, status: 'succeeded', stdout: 'ok', shell: shellId }, duration: 1000 }
}

function deps(overrides: Partial<Parameters<typeof runShellWithHostFallback>[0]> = {}) {
  return {
    prepared: makePrepared(),
    ctx: makeCtx(),
    started: Date.now(),
    baseLog: { requestId: 'req-1', sessionId: 'sess-1', commandFingerprint: 'x' },
    primaryResult: hostInitFailure(),
    runPrepared: vi.fn(async () => successResult('builtin-windows-cmd')),
    availability: { 'builtin-windows-powershell': true, 'builtin-windows-pwsh': false, 'builtin-windows-cmd': true },
    platform: 'win32' as NodeJS.Platform,
    ...overrides
  }
}

describe('runShellWithHostFallback（P0-C 降级编排）', () => {
  it('降级到可用宿主执行成功，并标注 degradedFrom 与实际 shell', async () => {
    const d = deps()
    const result = await runShellWithHostFallback(d)
    expect(d.runPrepared).toHaveBeenCalledTimes(1)
    const degradedPrepared = vi.mocked(d.runPrepared).mock.calls[0]![0] as PreparedShellExecution
    expect(degradedPrepared.spawnSpec.shellId).toBe('builtin-windows-cmd')
    expect(degradedPrepared.spawnSpec.executable).toBe('cmd.exe')
    expect(degradedPrepared.spawnSpec.args).toEqual(['/d', '/s', '/c', 'echo ok'])
    // 参数模板重新生成（约束 2）：不残留 -EncodedCommand
    expect(degradedPrepared.spawnSpec.args.join(' ')).not.toContain('-EncodedCommand')
    expect(result.success).toBe(true)
    expect((result.data as { degradedFrom?: string }).degradedFrom).toBe('builtin-windows-powershell')
    expect((result.data as { shell?: string }).shell).toBe('builtin-windows-cmd')
    // 降级透明（约束 3）：落一条 degrade 日志
    expect(logShellAgentEvent).toHaveBeenCalledWith(
      'warn',
      'shell.exec.degrade',
      expect.objectContaining({ shell: 'builtin-windows-cmd', degradedFrom: 'builtin-windows-powershell' })
    )
  })

  it('首个候选再次宿主失败时继续沿链尝试，最终成功仍标注原始宿主', async () => {
    const runPrepared = vi.fn()
      .mockResolvedValueOnce(hostInitFailure('builtin-windows-pwsh'))
      .mockResolvedValueOnce(successResult('builtin-windows-cmd'))
    const d = deps({
      availability: { 'builtin-windows-powershell': true, 'builtin-windows-pwsh': true, 'builtin-windows-cmd': true },
      runPrepared
    })
    const result = await runShellWithHostFallback(d)
    expect(runPrepared).toHaveBeenCalledTimes(2)
    const first = runPrepared.mock.calls[0]![0] as PreparedShellExecution
    const second = runPrepared.mock.calls[1]![0] as PreparedShellExecution
    expect(first.spawnSpec.shellId).toBe('builtin-windows-pwsh')
    expect(second.spawnSpec.shellId).toBe('builtin-windows-cmd')
    expect(result.success).toBe(true)
    expect((result.data as { degradedFrom?: string }).degradedFrom).toBe('builtin-windows-powershell')
  })

  it('命令方言与全部可用候选不兼容 → 结构化错误，不硬跑（§7.1 #6）', async () => {
    const runPrepared = vi.fn(async () => successResult('builtin-windows-cmd'))
    const d = deps({ command: undefined as never, runPrepared })
    d.prepared = makePrepared('$env:FOO = "bar"; Write-Output $env:FOO')
    const result = await runShellWithHostFallback(d)
    expect(runPrepared).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toBe(SHELL_HOST_DEGRADE_DIALECT_INCOMPATIBLE)
    const data = result.data as { degradedFrom?: string; incompatible?: Array<{ id: string }>; hostInitExitCode?: number }
    expect(data.degradedFrom).toBe('builtin-windows-powershell')
    expect(data.incompatible?.map((c) => c.id)).toEqual(['builtin-windows-cmd'])
    expect(data.hostInitExitCode).toBe(4294901760)
  })

  it('无可用候选 → 原样返回宿主失败结果，不标 degradedFrom（未实际降级，评审观察项 1）', async () => {
    const d = deps({
      availability: { 'builtin-windows-powershell': true, 'builtin-windows-pwsh': false, 'builtin-windows-cmd': false }
    })
    const result = await runShellWithHostFallback(d)
    expect(d.runPrepared).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toBe('SHELL_PROCESS_EXIT')
    const data = result.data as { degradedFrom?: string; exitCode?: number; shell?: string }
    expect(data.degradedFrom).toBeUndefined()
    expect(data.exitCode).toBe(4294901760)
    // 实际宿主仍是原宿主
    expect(data.shell).toBe('builtin-windows-powershell')
  })

  it('非宿主失败（普通错误）原样返回，不降级', async () => {
    const primary: ToolExecutorResult = { success: false, error: 'SHELL_TIMEOUT', data: { exitCode: null, status: 'timed_out' }, duration: 5000 }
    const d = deps({ primaryResult: primary })
    const result = await runShellWithHostFallback(d)
    expect(d.runPrepared).not.toHaveBeenCalled()
    expect(result).toBe(primary)
  })

  it('非 win32 平台不降级', async () => {
    const d = deps({ platform: 'linux' })
    const result = await runShellWithHostFallback(d)
    expect(d.runPrepared).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
  })
})
