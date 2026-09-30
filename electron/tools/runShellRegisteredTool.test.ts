import { describe, expect, it, vi } from 'vitest'
import { runShellRegisteredTool, RunShellExecutionUncertainError } from './runShellRegisteredTool'
import { getRegisteredTool } from './builtinExecutors'
import { createAgentRuntime } from '../runtime/agentRuntime'
import { setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'
import { ConfirmIdSpace } from '../remote/confirmId'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { createPermitBoundCoordinatorDispatch } from './permitBoundCoordinatorDispatch'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import * as runShellExecutor from './runShellExecutor'
import { buildWriteExecutionPermit } from '../confirmation/writeExecutionPermit'
import { writeFileExecutor } from './builtinExecutors'
import { browserExecutor } from './browserExecutor'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'


const runtime = {
  workDir: process.cwd(), userDataDir: process.cwd(), requestId: 'r', toolUseId: 'u', sessionId: 's',
  signal: new AbortController().signal,
  sendProgress: () => undefined,
  fileStateCache: new Map() as never,
  toolsConfig: {} as never,
  shellConfig: { enabled: true, shellDefaultTimeoutSec: 5, maxInlineOutputBytes: 4096 }
}

// P8:显式装配含真 builtin registry 的默认 runtime(兼容转发打到真实注册表)
setDefaultAgentRuntime(
  createAgentRuntime({
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry()
  })
)

describe('runShellRegisteredTool', () => {
  it('builtin registry exposes the planned registration as its only tool view', () => {
    expect(getRegisteredTool('run_shell')).toBe(runShellRegisteredTool)
    const registry = createBuiltinToolRegistry()
    expect(registry.get('run_shell')).toBe(runShellRegisteredTool)
    expect(registry.entries().every((tool) => tool.kind === 'planned')).toBe(true)
  })

  it('production builtin registry does not synthesize direct registrations', () => {
    const direct = createBuiltinToolRegistry().entries().filter((tool) => tool.kind === 'direct').map((tool) => tool.name)
    expect(direct).toEqual([])
  })

  it('write_file 与 edit_file 使用可复检的 prepared registration，不再生成 legacy direct 视图', () => {
    const registry = createBuiltinToolRegistry()
    expect(registry.get('write_file')?.kind).toBe('planned')
    expect(registry.get('edit_file')?.kind).toBe('planned')
  })

  it('run_script 使用绑定脚本内容与解释器配置的 prepared registration', () => {
    expect(createBuiltinToolRegistry().get('run_script')?.kind).toBe('planned')
  })

  it('四条 read lane 以 ReadExecutionPermit 驱动 prepared registration', () => {
    const registry = createBuiltinToolRegistry()
    expect(registry.get('read_file')?.kind).toBe('planned')
    expect(registry.get('list_directory')?.kind).toBe('planned')
    expect(registry.get('grep')?.kind).toBe('planned')
    expect(registry.get('read_feishu_attachment')?.kind).toBe('planned')
  })

  it('switch_work_dir uses a prepared target-bound registration', () => {
    expect(createBuiltinToolRegistry().get('switch_work_dir')?.kind).toBe('planned')
  })

  it('switch_session uses a prepared session-identity registration', () => {
    expect(createBuiltinToolRegistry().get('switch_session')?.kind).toBe('planned')
  })

  it('browser uses a prepared invocation with a frozen browser policy snapshot', () => {
    expect(createBuiltinToolRegistry().get('browser')?.kind).toBe('planned')
  })

  it('WeChat outbound tools use prepared recipient/session-bound registrations', () => {
    const registry = createBuiltinToolRegistry()
    expect(registry.get('wechat_send')?.kind).toBe('planned')
    expect(registry.get('wechat_reply')?.kind).toBe('planned')
  })

  it('run_lark_cli uses a prepared executable/argv registration', () => {
    expect(createBuiltinToolRegistry().get('run_lark_cli')?.kind).toBe('planned')
  })

  it('list_work_dirs uses a prepared remote caller/config snapshot registration', () => {
    expect(createBuiltinToolRegistry().get('list_work_dirs')?.kind).toBe('planned')
  })

  it('browser configuration drift after confirmation blocks dispatch and browser executor', async () => {
    const registered = createBuiltinToolRegistry().get('browser')!
    const browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, deniedActions: [] as string[] }
    const executionContext = { ...runtime, browserConfig } as never
    const executor = vi.spyOn(browserExecutor, 'execute')
    let dispatched = false

    await expect(executeRegisteredTool(registered, { action: 'navigate', url: 'https://example.com' }, {
      requestId: 'r', toolUseId: 'browser-drift', signal: runtime.signal, executionContext
    }, {
      confirm: async () => {
        browserConfig.deniedActions.push('navigate')
        return true
      },
      dispatch: async (_handle, _context, run) => {
        dispatched = true
        return run(new AbortController().signal)
      }
    })).rejects.toThrow('BROWSER_PREPARED_POLICY_CHANGED')

    expect(dispatched).toBe(false)
    expect(executor).not.toHaveBeenCalled()
    executor.mockRestore()
  })

  it('write_file permit 在 plan 后被替换时于文件 executor 前 fail closed', async () => {
    const registered = createBuiltinToolRegistry().get('write_file')!
    const input = { path: 'guarded.txt', content: 'prepared content' }
    const makePermit = (decisionRuleId: string) => buildWriteExecutionPermit({
      requestId: 'r', toolUseId: 'write-plan-replace', toolName: 'write_file', input,
      target: {
        rawPath: 'guarded.txt', normalizedPath: '/tmp/guarded.txt', zone: 'workdir-normal', targetKind: 'missing',
        parentReal: '/tmp', parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 0, mtimeMs: 1, nlink: 2 }
      }, decisionRuleId, approval: 'confirmed'
    })
    const runtimeContext = { ...runtime, writeExecutionPermit: makePermit('rule-v1') } as never
    const signal = new AbortController().signal
    const handle = await registered.begin(input, { requestId: 'r', toolUseId: 'write-plan-replace', signal, executionContext: runtimeContext })
    handle.awaitConfirmation()
    handle.confirm()
    const executor = vi.spyOn(writeFileExecutor, 'execute')
    ;(runtimeContext as { writeExecutionPermit: unknown }).writeExecutionPermit = makePermit('rule-v2')
    await expect(handle.execute({
      requestId: 'r', toolUseId: 'write-plan-replace', toolName: 'write_file', signal, runtimeContext
    } as never)).rejects.toThrow('WRITE_PREPARED_PERMIT_CHANGED')
    expect(executor).not.toHaveBeenCalled()
    handle.release()
    executor.mockRestore()
  })

  it('在 plan 阶段生成 prepared plan，execute 不接受原始 command', async () => {
    // 命令文本按宿主平台方言给出：Windows 只有 Windows PowerShell profile。
    const command = process.platform === 'win32' ? 'Write-Output planned' : 'printf planned'
    const handle = await runShellRegisteredTool.begin(
      { command },
      { requestId: 'r', toolUseId: 'u', signal: runtime.signal, executionContext: runtime }
    )
    expect(handle.prepared.kind).toBe('planned')
    expect(handle.stateHistory).toEqual(['planning', 'planned'])
    handle.awaitConfirmation()
    handle.confirm()
    const result = await handle.execute({
      requestId: 'r', toolUseId: 'u', signal: runtime.signal, toolName: 'run_shell', runtimeContext: runtime
    })
    expect(result).toMatchObject({ success: true })
  })

  it('shell 已启动后超时将结果归为不确定，避免把部分副作用作为可重试工具结果', async () => {
    const executor = vi.spyOn(runShellExecutor, 'executePreparedShellExecutionWithHostFallback')
      .mockResolvedValue({ success: false, error: 'SHELL_TIMEOUT' } as never)
    const handle = await runShellRegisteredTool.begin(
      { command: process.platform === 'win32' ? 'Write-Output started' : 'printf started' },
      { requestId: 'r', toolUseId: 'shell-timeout-uncertain', signal: runtime.signal, executionContext: runtime }
    )
    handle.awaitConfirmation()
    handle.confirm()

    try {
      await expect(handle.execute({
        requestId: 'r', toolUseId: 'shell-timeout-uncertain', signal: runtime.signal,
        toolName: 'run_shell', runtimeContext: runtime
      } as never)).rejects.toBeInstanceOf(RunShellExecutionUncertainError)
      expect(executor).toHaveBeenCalledOnce()
    } finally {
      handle.release()
      executor.mockRestore()
    }
  })

  it('shell 已启动后达到输出上限将结果归为不确定', async () => {
    const executor = vi.spyOn(runShellExecutor, 'executePreparedShellExecutionWithHostFallback')
      .mockResolvedValue({ success: false, error: 'OUTPUT_LIMIT_REACHED' } as never)
    const handle = await runShellRegisteredTool.begin(
      { command: process.platform === 'win32' ? 'Write-Output started' : 'printf started' },
      { requestId: 'r', toolUseId: 'shell-output-limit-uncertain', signal: runtime.signal, executionContext: runtime }
    )
    handle.awaitConfirmation()
    handle.confirm()

    try {
      await expect(handle.execute({
        requestId: 'r', toolUseId: 'shell-output-limit-uncertain', signal: runtime.signal,
        toolName: 'run_shell', runtimeContext: runtime
      } as never)).rejects.toBeInstanceOf(RunShellExecutionUncertainError)
      expect(executor).toHaveBeenCalledOnce()
    } finally {
      handle.release()
      executor.mockRestore()
    }
  })

  it('shell 进程树终止未确认时将结果归为不确定', async () => {
    const executor = vi.spyOn(runShellExecutor, 'executePreparedShellExecutionWithHostFallback')
      .mockResolvedValue({ success: false, error: 'SHELL_PROCESS_EXIT', data: { terminationErrorCode: 'TERMINATION_UNCONFIRMED' } } as never)
    const handle = await runShellRegisteredTool.begin(
      { command: process.platform === 'win32' ? 'Write-Output started' : 'printf started' },
      { requestId: 'r', toolUseId: 'shell-termination-uncertain', signal: runtime.signal, executionContext: runtime }
    )
    handle.awaitConfirmation()
    handle.confirm()

    try {
      await expect(handle.execute({
        requestId: 'r', toolUseId: 'shell-termination-uncertain', signal: runtime.signal,
        toolName: 'run_shell', runtimeContext: runtime
      } as never)).rejects.toBeInstanceOf(RunShellExecutionUncertainError)
      expect(executor).toHaveBeenCalledOnce()
    } finally {
      handle.release()
      executor.mockRestore()
    }
  })

  it('shell planned executor 只有经过 dispatch claim 才可启动', async () => {
    const command = process.platform === 'win32' ? 'Write-Output permit-bound' : 'printf permit-bound'
    const events: string[] = []
    await expect(executeRegisteredTool(runShellRegisteredTool, { command }, {
      requestId: 'r', toolUseId: 'u', signal: runtime.signal, executionContext: runtime
    }, {
      confirm: async () => true,
      dispatch: async (handle, _context, execute) => {
        events.push(`claim:${handle.prepared.toolName}`)
        return execute(new AbortController().signal)
      }
    })).resolves.toMatchObject({ success: true })
    expect(events).toEqual(['claim:run_shell'])
  })

  it('真实 run_shell 命令启动后撤权返回 unknown outcome，不暴露为普通取消结果', async () => {
    const controller = new AbortController()
    const executionRuntime = { ...runtime, signal: controller.signal }
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
    const handle = await runShellRegisteredTool.begin(
      { command, timeout: 60 },
      { requestId: 'r', toolUseId: 'running-shell-cancel', signal: controller.signal, executionContext: executionRuntime }
    )
    handle.awaitConfirmation()
    handle.confirm()
    const execution = handle.execute({
      requestId: 'r', toolUseId: 'running-shell-cancel', signal: controller.signal,
      toolName: 'run_shell', runtimeContext: executionRuntime
    } as never)

    await new Promise((resolve) => setTimeout(resolve, 500))
    controller.abort()
    await expect(execution).rejects.toMatchObject({ name: 'RunShellExecutionUncertainError' })
    expect(handle.stateHistory).toContain('executing')
    handle.release()
  }, 15_000)

  it('shell prepared builtin 在 consume 后撤权时不会进入实际 executor', async () => {
    const command = process.platform === 'win32' ? 'Write-Output barrier' : 'printf barrier'
    const toolRevocations = new ToolRevocationRegistry()
    toolRevocations.registerToolRevocationRequest('r', 'desktop', 'turn')
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (permitId: string, binding: Parameters<typeof ledger.markPermitConsumed>[1]) => ledger.markPermitConsumed(permitId, binding),
      beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
        reachedClaim()
        await barrier
        return ledger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (permitId: string) => ledger.settle(permitId)
    }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'r', turnId: 'turn', canonicalInput: { command },
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => !toolRevocations.isToolRevoked('r', 'run_shell'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      toolRevocations, admission
    })
    const executor = vi.spyOn(runShellExecutor, 'executePreparedShellExecutionWithHostFallback')
    const result = executeRegisteredTool(runShellRegisteredTool, { command }, {
      requestId: 'r', toolUseId: 'barrier-shell-call', signal: runtime.signal, executionContext: runtime
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(executor).not.toHaveBeenCalled()
    expect(toolRevocations.revokeToolForLane('desktop', 'run_shell')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('r')).toBe(0)
    executor.mockRestore()
  })

  it('shell prepared builtin 在 claim barrier 中授权版本变化时不会启动 shell', async () => {
    const command = process.platform === 'win32' ? 'Write-Output stale' : 'printf stale'
    const toolRevocations = new ToolRevocationRegistry()
    toolRevocations.registerToolRevocationRequest('r', 'desktop', 'turn')
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (permitId: string, binding: Parameters<typeof ledger.markPermitConsumed>[1]) => ledger.markPermitConsumed(permitId, binding),
      beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
        reachedClaim()
        await barrier
        return ledger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (permitId: string) => ledger.settle(permitId)
    }
    let authorizationVersion = 'rule-v1'
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'r', turnId: 'turn', canonicalInput: { command },
      authorizationVersion, currentAuthorizationVersion: () => authorizationVersion,
      targetVersion: 'target-v1', phase: 'recheck',
      initialFactsHash: 'facts-v1', isAllowed: () => !toolRevocations.isToolRevoked('r', 'run_shell'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      toolRevocations, admission
    })
    const executor = vi.spyOn(runShellExecutor, 'executePreparedShellExecutionWithHostFallback')
    const result = executeRegisteredTool(runShellRegisteredTool, { command }, {
      requestId: 'r', toolUseId: 'barrier-shell-version', signal: runtime.signal, executionContext: runtime
    }, { confirm: async () => true, dispatch })
    try {
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      authorizationVersion = 'rule-v2'
      releaseClaim()
      await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
      expect(executor).not.toHaveBeenCalled()
      expect(ledger.activeLeaseCount('r')).toBe(0)
    } finally {
      releaseClaim()
      executor.mockRestore()
    }
  })
})
