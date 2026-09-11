import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { getToolExecutor, resolvePythonInterpreter } from './builtinExecutors'

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

describe.skipIf(!pythonInterpreter)('run_script result contract', () => {
  it('失败时保留结构化 stderr 与稳定错误码', async () => {
    const executor = getToolExecutor('run_script')!
    const result = await executor.execute({ code: "import sys; print('ValueError: bad', file=sys.stderr); raise SystemExit(1)" }, ctx())
    expect(result).toMatchObject({ success: false, error: 'SCRIPT_PROCESS_EXIT', data: { status: 'failed', exitCode: 1 } })
    expect(String(result.data && (result.data as { stderr?: string }).stderr)).toContain('ValueError: bad')
  }, 20_000)

  it('成功空 stdout 仍然是 succeeded，不伪造成失败', async () => {
    const executor = getToolExecutor('run_script')!
    const result = await executor.execute({ code: 'pass' }, ctx())
    expect(result).toMatchObject({ success: true, data: { status: 'succeeded', exitCode: 0 } })
  }, 20_000)
})

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
