import { describe, expect, it } from 'vitest'
import { runShellRegisteredTool } from './runShellRegisteredTool'
import { getRegisteredTool, getToolExecutor } from './builtinExecutors'
import { createAgentRuntime } from '../runtime/agentRuntime'
import { setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'
import { ConfirmIdSpace } from '../remote/confirmId'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'


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
  it('builtin registry 同时暴露 planned registration 和兼容 executor', () => {
    expect(getRegisteredTool('run_shell')).toBe(runShellRegisteredTool)
    expect(getToolExecutor('run_shell')?.name).toBe('run_shell')
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
})
