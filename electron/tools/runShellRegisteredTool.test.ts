import { describe, expect, it } from 'vitest'
import { runShellRegisteredTool } from './runShellRegisteredTool'
import { getRegisteredTool, getToolExecutor } from './builtinExecutors'

const runtime = {
  workDir: process.cwd(), userDataDir: process.cwd(), requestId: 'r', toolUseId: 'u', sessionId: 's',
  signal: new AbortController().signal,
  sendProgress: () => undefined,
  fileStateCache: new Map() as never,
  toolsConfig: {} as never,
  shellConfig: { enabled: true, shellDefaultTimeoutSec: 5, maxInlineOutputBytes: 4096 }
}

describe('runShellRegisteredTool', () => {
  it('builtin registry 同时暴露 planned registration 和兼容 executor', () => {
    expect(getRegisteredTool('run_shell')).toBe(runShellRegisteredTool)
    expect(getToolExecutor('run_shell')?.name).toBe('run_shell')
  })

  it('在 plan 阶段生成 prepared plan，execute 不接受原始 command', async () => {
    const handle = await runShellRegisteredTool.begin(
      { command: 'printf planned' },
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
})
