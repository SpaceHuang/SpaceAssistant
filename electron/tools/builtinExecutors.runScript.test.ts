import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createBuiltinToolRegistry, resolvePythonInterpreter, runScriptExecutor } from './builtinExecutors'
import { createAgentRuntime } from '../runtime/agentRuntime'
import { setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { ConfirmIdSpace } from '../remote/confirmId'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'
import { createRunScriptRegisteredTool, RunScriptExecutionUncertainError } from './runScriptRegisteredTool'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { createPermitBoundCoordinatorDispatch } from './permitBoundCoordinatorDispatch'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'


/**
 * run_script 的结果契约依赖宿主 Python 解释器。探测顺序对齐产品默认值
 * （DEFAULT_TOOLS_CONFIG.pythonPath = 'python'，执行器同样回退 'python'）：
 * PYTHON → 平台默认 → Windows 启动器 py → python3 → python；
 * 都不可用时整组跳过，避免把"本机没装解释器"误报成契约回归。
 */
function detectHostPythonInterpreter(): string | undefined {
  const candidates = [
    process.env.PYTHON?.trim(),
    process.platform === 'win32' ? 'python' : 'python3',
    process.platform === 'win32' ? 'py' : 'python',
    'python3',
    'python'
  ].filter((value): value is string => Boolean(value))
  const tried = new Set<string>()
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue
    tried.add(candidate)
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    if (probe.status === 0) return candidate
  }
  return undefined
}

const pythonInterpreter = detectHostPythonInterpreter()
if (!pythonInterpreter) {
  console.warn(
    '[run_script result contract] 未找到可用的 Python 解释器（PYTHON / python / py / python3），跳过本组用例'
  )
}

function ctx() {
  return {
    workDir: process.cwd(), userDataDir: '/tmp', requestId: 'r', toolUseId: 't', sessionId: 's',
    sendProgress: vi.fn(), signal: new AbortController().signal, fileStateCache: {} as never,
    // 解析不到时保持产品默认值；此时 describe.skipIf 已整组跳过。
    toolsConfig: { enabled: true, allowedTools: [], deniedTools: [], scriptTimeout: 5, pythonPath: pythonInterpreter ?? 'python' }
  } as never
}

describe('run_script language dispatch', () => {
  it('script 已启动后超时将结果归为不确定，避免部分副作用作为可重试结果返回', async () => {
    const executor = vi.fn(async () => ({ success: false, error: 'SCRIPT_TIMEOUT' }))
    const registered = createRunScriptRegisteredTool({ name: 'run_script', execute: executor } as never)
    const executionContext = ctx()
    const handle = await registered.begin(
      { language: 'python', code: 'write_then_wait()', timeout: 1 },
      { requestId: 'script-timeout', toolUseId: 'script-timeout-call', signal: executionContext.signal, executionContext }
    )
    handle.awaitConfirmation()
    handle.confirm()

    try {
      await expect(handle.execute({
        requestId: 'script-timeout', toolUseId: 'script-timeout-call', signal: executionContext.signal,
        toolName: 'run_script', runtimeContext: executionContext
      } as never)).rejects.toBeInstanceOf(RunScriptExecutionUncertainError)
      expect(executor).toHaveBeenCalledOnce()
    } finally {
      handle.release()
    }
  })

  it('script claim barrier 中授权版本变化时不会启动进程执行器', async () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('script-auth-version', 'desktop')
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
    const input = { language: 'python', code: 'print("must not execute")' }
    let authorizationVersion = 'rule-v1'
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'script-auth-version', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', currentAuthorizationVersion: () => authorizationVersion,
      targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !registry.isToolRevoked('script-auth-version', 'run_script'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      toolRevocations: registry, admission
    })
    const executor = vi.fn(async () => ({ success: true }))
    const registered = createRunScriptRegisteredTool({ name: 'run_script', execute: executor } as never)
    const runtime = ctx()
    const result = executeRegisteredTool(registered, input, {
      requestId: 'script-auth-version', toolUseId: 'script-auth-version-call', signal: runtime.signal,
      executionContext: runtime
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(executor).not.toHaveBeenCalled()
    authorizationVersion = 'rule-v2'
    releaseClaim()
    await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('script-auth-version')).toBe(0)
  })

  it('script revoke after permit consume and before admission claim prevents process executor entry', async () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('script-claim', 'desktop')
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
    const input = { language: 'python', code: 'print("must not execute")' }
    const safetyPolicy = { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) }
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'script-claim', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !registry.isToolRevoked('script-claim', 'run_script'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy, toolRevocations: registry, admission
    })
    const executor = vi.spyOn(runScriptExecutor, 'execute')
    const registered = createBuiltinToolRegistry().get('run_script')!
    const runtime = ctx() as { signal: AbortSignal; workDir: string; userDataDir: string; toolsConfig: unknown }
    const result = executeRegisteredTool(registered, input, {
      requestId: 'script-claim', toolUseId: 'script-claim-call', signal: runtime.signal,
      executionContext: runtime as never
    }, { confirm: async () => true, dispatch })
    await atClaim
    expect(executor).not.toHaveBeenCalled()
    expect(registry.revokeToolForLane('desktop', 'run_script')).toBe(1)
    releaseClaim()
    await expect(result).rejects.toThrow('REVOKED')
    expect(executor).not.toHaveBeenCalled()
    expect(ledger.activeLeaseCount('script-claim')).toBe(0)
    executor.mockRestore()
  })

  it('script revoke after dispatch claim aborts the execution lease signal and settles', async () => {
    const registry = new ToolRevocationRegistry()
    registry.registerToolRevocationRequest('script-running', 'desktop')
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const input = { language: 'python', code: 'print("running")' }
    const execution = vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { success: false, error: 'SCRIPT_CANCELLED' }
    })
    const tool = createRunScriptRegisteredTool({
      name: 'run_script',
      execute: execution
    } as never)
    const context = ctx() as { signal: AbortSignal; workDir: string; userDataDir: string; toolsConfig: unknown }
    let leaseSignal: AbortSignal | undefined
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'script-running', turnId: 'turn', canonicalInput: input,
      authorizationVersion: 'rule-v1', targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      isAllowed: () => !registry.isToolRevoked('script-running', 'run_script'),
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      toolRevocations: registry, admission
    })
    const result = executeRegisteredTool(tool, input, {
      requestId: 'script-running', toolUseId: 'script-running-call', signal: context.signal,
      executionContext: context as never
    }, { confirm: async () => true, dispatch: async (handle, toolContext, execute) => {
      const dispatched = await dispatch(handle, toolContext, async (signal) => {
        leaseSignal = signal
        return execute(signal)
      })
      return dispatched
    } })
    await vi.waitFor(() => expect(leaseSignal).toBeDefined())
    expect(leaseSignal?.aborted).toBe(false)
    expect(registry.revokeToolForLane('desktop', 'run_script')).toBe(1)
    await expect(result).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    expect(execution).toHaveBeenCalledOnce()
    expect(leaseSignal?.aborted).toBe(true)
    expect(admission.activeLeaseCount('script-running')).toBe(0)
  })

  it('interpreter settings changed after preparation reject before dispatch and executor', async () => {
    const execution = vi.fn(async () => ({ success: true }))
    const tool = createRunScriptRegisteredTool({ name: 'run_script', execute: execution } as never)
    const runtime = ctx() as { workDir: string; userDataDir: string; toolsConfig: { scriptTimeout: number; pythonPath: string } }
    let dispatchEntered = false
    await expect(executeRegisteredTool(tool, { language: 'python', code: 'print(1)' }, {
      requestId: 'script-prepared', toolUseId: 'call-1', signal: new AbortController().signal,
      executionContext: runtime as never
    }, {
      confirm: async () => {
        runtime.toolsConfig.pythonPath = 'replacement-python'
        return true
      },
      dispatch: async (_handle, _context, execute) => {
        dispatchEntered = true
        return execute(new AbortController().signal)
      }
    })).rejects.toThrow('RUN_SCRIPT_PREPARED_SETTINGS_CHANGED')
    expect(dispatchEntered).toBe(false)
    expect(execution).not.toHaveBeenCalled()
  })

  it('executes JavaScript and TypeScript with Node after gate-level language selection', async () => {
    const executor = runScriptExecutor
    const context = () => ({
      ...ctx(),
      toolsConfig: {
        enabled: true, allowedTools: [], deniedTools: [], scriptTimeout: 5, pythonPath: 'python',
        scriptInterpreterPaths: { javascript: process.execPath, typescript: process.execPath }
      }
    }) as never
    const js = await executor.execute({ language: 'javascript', code: "console.log('javascript-output')" }, context())
    const ts = await executor.execute({ language: 'typescript', code: "const answer: string = 'typescript-output'; console.log(answer)" }, context())
    expect(js).toMatchObject({ success: true, data: { status: 'succeeded' } })
    expect((js.data as { stdout?: string }).stdout).toContain('javascript-output')
    expect(ts).toMatchObject({ success: true, data: { status: 'succeeded' } })
    expect((ts.data as { stdout?: string }).stdout).toContain('typescript-output')
  }, 20_000)
})

describe.skipIf(!pythonInterpreter)('run_script result contract', () => {
  it('失败时保留结构化 stderr 与稳定错误码', async () => {
    const executor = runScriptExecutor
    const result = await executor.execute({ code: "import sys; print('ValueError: bad', file=sys.stderr); raise SystemExit(1)" }, ctx())
    expect(result).toMatchObject({ success: false, error: 'SCRIPT_PROCESS_EXIT', data: { status: 'failed', exitCode: 1 } })
    expect(String(result.data && (result.data as { stderr?: string }).stderr)).toContain('ValueError: bad')
  }, 20_000)

  it('成功空 stdout 仍然是 succeeded，不伪造成失败', async () => {
    const executor = runScriptExecutor
    const result = await executor.execute({ code: 'pass' }, ctx())
    expect(result).toMatchObject({ success: true, data: { status: 'succeeded', exitCode: 0 } })
  }, 20_000)
})

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

describe('resolvePythonInterpreter', () => {
  it('默认值不可用时按平台回退到 py / python3', async () => {
    const winCalls: string[] = []
    const winProbe = async (command: string): Promise<boolean> => {
      winCalls.push(command)
      return command === 'py'
    }
    await expect(resolvePythonInterpreter(undefined, { platform: 'win32', probe: winProbe })).resolves.toEqual({
      command: 'py',
      fallbackFrom: 'python'
    })
    expect(winCalls).toEqual(['python', 'py'])

    const posixCalls: string[] = []
    const posixProbe = async (command: string): Promise<boolean> => {
      posixCalls.push(command)
      return command === 'python3'
    }
    await expect(resolvePythonInterpreter('  ', { platform: 'darwin', probe: posixProbe })).resolves.toEqual({
      command: 'python3',
      fallbackFrom: 'python'
    })
    expect(posixCalls).toEqual(['python', 'python3'])
  })

  it('默认值可用时不额外探测其他候选', async () => {
    const probe = vi.fn(async () => true)
    await expect(resolvePythonInterpreter('python', { platform: 'win32', probe })).resolves.toEqual({ command: 'python' })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith('python')
  })

  it('显式配置的自定义解释器失败时不静默替换', async () => {
    const probe = vi.fn(async () => false)
    await expect(resolvePythonInterpreter('/opt/custom/python', { platform: 'linux', probe })).resolves.toEqual({
      command: '/opt/custom/python'
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('全部候选不可用时保留原值，错误信息仍指向用户配置', async () => {
    const probe = async (): Promise<boolean> => false
    await expect(resolvePythonInterpreter(undefined, { platform: 'win32', probe })).resolves.toEqual({
      command: 'python'
    })
  })
})
