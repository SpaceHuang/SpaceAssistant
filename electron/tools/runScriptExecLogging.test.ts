import { describe, expect, it, vi } from 'vitest'
import { getToolExecutor } from './builtinExecutors'
import { createAgentRuntime } from '../runtime/agentRuntime'
import { setDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { createBuiltinToolRegistry } from './builtinExecutors'
import { ConfirmIdSpace } from '../remote/confirmId'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'
import { spawnSync } from 'node:child_process'

vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  initAgentLogger: vi.fn(),
  flushAgentLogger: vi.fn().mockResolvedValue(undefined)
}))

import { logAgentEvent } from '../agentLogger/agentLogger'
import { projectAgentLogFields } from '../agentLogger/agentLogProjection'

// ===== P0-D3 组 1：为 run_script 补执行期事件（§7.1 #2c）=====
// 此前 run_script 只有策略/确认期事件（script.ask 等），执行期只走 IPC 进度不落盘，
// "成功的那条路径"没有任何可事后分析的执行期证据（§5.4.3 缺口）。

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

function ctx() {
  return {
    workDir: process.cwd(), userDataDir: '/tmp', requestId: 'r', toolUseId: 't', sessionId: 's',
    sendProgress: vi.fn(), signal: new AbortController().signal, fileStateCache: {} as never,
    toolsConfig: { enabled: true, allowedTools: [], deniedTools: [], scriptTimeout: 5, pythonPath: pythonInterpreter ?? 'python' }
  } as never
}

setDefaultAgentRuntime(
  createAgentRuntime({
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry()
  })
)

describe.skipIf(!pythonInterpreter)('run_script 执行期事件（P0-D3 组 1）', () => {
  it('成功执行后落 script.exec.start / spawned / finish，字段与 shell.exec.* 对齐', async () => {
    vi.mocked(logAgentEvent).mockClear()
    const executor = getToolExecutor('run_script')!
    const result = await executor.execute({ code: 'print("ok")' }, ctx())
    expect(result.success).toBe(true)

    const events = vi.mocked(logAgentEvent).mock.calls.map(([, event]) => event)
    expect(events).toContain('script.exec.start')
    expect(events).toContain('script.exec.spawned')
    expect(events).toContain('script.exec.finish')

    const start = vi.mocked(logAgentEvent).mock.calls.find(([, event]) => event === 'script.exec.start')?.[2] as Record<string, unknown>
    expect(start).toMatchObject({ requestId: 'r', sessionId: 's', toolUseId: 't', timeoutSec: 5 })
    // 评审观察项 5：传原始 code，指纹化由投影层负责（与 run_shell 的 command 同模式），不再双重哈希
    expect(start.code).toBe('print("ok")')
    // 投影路由：script.exec.* 走 Shell/Script allowlist，code → codeFingerprint、值永不落盘
    const projected = projectAgentLogFields('script.exec.start', start)
    expect(projected.codeFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(projected.code).toBeUndefined()

    const spawned = vi.mocked(logAgentEvent).mock.calls.find(([, event]) => event === 'script.exec.spawned')?.[2] as Record<string, unknown>
    expect(spawned.pid).toBeTypeOf('number')
    // 解析后的解释器以 basename 记录（不含路径，遵守日志脱敏纪律）
    expect(String(spawned.interpreter)).not.toContain('/')
    expect(String(spawned.interpreter)).not.toContain('\\')

    const finish = vi.mocked(logAgentEvent).mock.calls.find(([, event]) => event === 'script.exec.finish')?.[2] as Record<string, unknown>
    expect(finish).toMatchObject({ exitCode: 0, status: 'succeeded', success: true, timedOut: false })
    expect(finish.durationMs).toBeTypeOf('number')
    // 组 5：env 快照字段（键计数 + 键集合哈希 + 逐键条目哈希）
    expect(finish.envKeyCount).toBeTypeOf('number')
    expect(finish.envKeysSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(finish.envEntriesSha256).toMatch(/^[0-9a-f]{64}$/)
  }, 20_000)

  it('失败执行：finish 标注 exitCode/success=false，stdout/stderr 只留字节口径', async () => {
    vi.mocked(logAgentEvent).mockClear()
    const executor = getToolExecutor('run_script')!
    const result = await executor.execute({ code: "import sys; print('bad', file=sys.stderr); raise SystemExit(3)" }, ctx())
    expect(result.success).toBe(false)

    const finish = vi.mocked(logAgentEvent).mock.calls.find(([, event]) => event === 'script.exec.finish')?.[2] as Record<string, unknown>
    expect(finish).toMatchObject({ exitCode: 3, status: 'failed', success: false })
    expect(finish.stderrBytes).toBeGreaterThan(0)
    expect(finish.stdout).toBeUndefined()
    expect(finish.stderr).toBeUndefined()
  }, 20_000)
})
