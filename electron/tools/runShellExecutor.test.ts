import fs from 'fs/promises'
import { createHash } from 'crypto'
import { spawn } from 'node:child_process'
import os from 'os'
import path from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendRawTailBuffer, executePreparedShellExecution, runShellExecutor, resolveShellSpawnSpec } from './runShellExecutor'
import { planRunShellExecution } from './runShellPlan'
import { appendProgressOutputRaw, decodeProgressRawTail } from '../../src/shared/terminalScrollback'
import { PROGRESS_RAW_MAX_BYTES } from '../../src/shared/terminalScrollback'

vi.mock('../shell/shellAgentLogger', () => ({
  logShellAgentEvent: vi.fn()
}))

import { logShellAgentEvent } from '../shell/shellAgentLogger'

const isWindows = process.platform === 'win32'
// Windows 侧每个用例都要真实启动 powershell.exe（本机 ~2s），冷机 CI 会明显更慢。
const SPAWN_TEST_TIMEOUT_MS = 45_000

/**
 * 产品目标方言固定为 Windows PowerShell 5.1 与 POSIX Bash，两者命令文本不通用。
 * 用例按方言给出命令文本，但断言（exitCode / stdout / stderr / 状态合同）保持平台一致。
 */
function shellCommand(bash: string, powershell: string): string {
  return isWindows ? powershell : bash
}

/** 路径断言：artifact 目录分隔符随平台变化。 */
function escapePathForRegExp(target: string): string {
  return target
    .split(/[\\/]/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]')
}

/** 输出不上屏且不含换行的 stdout 写法，便于断言精确字节数。 */
function writeStdout(text: string): string {
  return `[Console]::Out.Write('${escapePowerShellLiteral(text)}')`
}

function writeStderr(text: string): string {
  return `[Console]::Error.Write('${escapePowerShellLiteral(text)}')`
}

/** PowerShell 单引号字符串里 `'` 需写成 `''`，否则后续传入含引号的文本会变成语法错误。 */
function escapePowerShellLiteral(text: string): string {
  return text.replace(/'/g, "''")
}

function baseCtx(workDir: string, userDataDir: string) {
  return {
    workDir,
    userDataDir,
    requestId: 'req',
    toolUseId: 'tool-1',
    sessionId: 'sess',
    sendProgress: vi.fn(),
    signal: new AbortController().signal,
    fileStateCache: {} as never,
    toolsConfig: { enabled: true, allowedTools: [], deniedTools: [] },
    shellConfig: {
      enabled: true,
      shellDefaultTimeoutSec: 300,
      maxInlineOutputBytes: 102400
    },
    shellOutputMode: 'plain' as const
  }
}

function progressPayloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const p = payload as { message?: string; raw?: string }
    if (typeof p.message === 'string') return p.message
    if (typeof p.raw === 'string') {
      try {
        return Buffer.from(p.raw, 'base64').toString('utf8')
      } catch {
        return ''
      }
    }
  }
  return ''
}

describe('runShellExecutor', () => {
  it('限制 terminal raw ring buffer，不随洪泛输出增长', () => {
    const first = appendRawTailBuffer(Buffer.alloc(0), Buffer.alloc(PROGRESS_RAW_MAX_BYTES + 100, 65))
    const second = appendRawTailBuffer(first, Buffer.from('tail'))
    expect(first.length).toBe(PROGRESS_RAW_MAX_BYTES)
    expect(second.length).toBe(PROGRESS_RAW_MAX_BYTES)
    expect(second.subarray(-4).toString()).toBe('tail')
  })
  let workDir: string
  let userDataDir: string

  beforeAll(async () => {
    if (!isWindows) return
    // PowerShell 首次启动要构建模块分析缓存，CI 冷机可能远超单个用例预算；先预热一次。
    await new Promise<void>((resolve) => {
      const warmup = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: 'ignore',
        windowsHide: true
      })
      warmup.once('exit', () => resolve())
      warmup.once('error', () => resolve())
    })
  }, 180_000)

  beforeEach(async () => {
    vi.mocked(logShellAgentEvent).mockClear()
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-shell-exec-'))
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-shell-ud-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(workDir, { recursive: true, force: true })
    } catch {
      /* Windows EBUSY */
    }
    try {
      await fs.rm(userDataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('resolveShellSpawnSpec uses platform default', () => {
    const spec = resolveShellSpawnSpec(null)
    if (process.platform === 'win32') {
      expect(spec.shellId).toBe('builtin-windows-powershell')
      expect(spec.executable).toBe('powershell.exe')
      expect(spec.args).toContain('-EncodedCommand')
    } else {
      expect(spec.shellId).toBe('bash')
      expect(spec.executable).toBe('/bin/bash')
      expect(spec.args).toEqual(['--noprofile', '--norc', '-c', ''])
    }
  })

  it('resolveShellSpawnSpec uses custom executable', () => {
    const spec = resolveShellSpawnSpec({
      enabled: true,
      shellDefaultTimeoutSec: 300,
      maxInlineOutputBytes: 102400,
      executable: '/usr/local/bin/bash',
      argsPrefix: ['-lc']
    })
    expect(spec.executable).toBe('/usr/local/bin/bash')
    expect(spec.args).toEqual(['-lc', ''])
  })

  it('quoted 路径切换工作目录在各平台方言下都生效', async () => {
    const target = path.join(workDir, 'nested dir')
    await fs.mkdir(target, { recursive: true })
    const cmd = shellCommand(
      `cd "${target}" && echo nested_ok`,
      `Set-Location -LiteralPath "${target}"; Write-Output nested_ok`
    )
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(result.success).toBe(true)
    expect(String(result.data?.stdout)).toMatch(/nested_ok/)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('runs echo successfully', async () => {
    const result = await runShellExecutor.execute({ command: 'echo hello' }, baseCtx(workDir, userDataDir))
    expect(result.success).toBe(true)
    expect(String(result.data?.stdout)).toMatch(/hello/)
    expect(result.data?.exitCode).toBe(0)
    expect(result.data?.planDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.data?.environmentFingerprint).toBeTruthy()
    expect(logShellAgentEvent).toHaveBeenCalledWith('info', 'shell.exec.start', expect.objectContaining({ commandFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }))
    expect(logShellAgentEvent).toHaveBeenCalledWith('info', 'shell.exec.spawned', expect.any(Object))
    expect(logShellAgentEvent).toHaveBeenCalledWith(
      'info',
      'shell.exec.finish',
      expect.objectContaining({ success: true, exitCode: 0 })
    )
    await expect(fs.stat(path.join(userDataDir, 'shell-output'))).rejects.toThrow()
  }, SPAWN_TEST_TIMEOUT_MS)

  it('保留包含 node_modules 的成功 stdout，不伪造成失败', async () => {
    const payload = 'node_modules dist-electron'
    const result = await runShellExecutor.execute(
      { command: shellCommand(`printf '${payload}\\n'`, writeStdout(payload)) },
      baseCtx(workDir, userDataDir)
    )
    expect(result).toMatchObject({ success: true, data: { exitCode: 0, status: 'succeeded' } })
    expect(String(result.data?.stdout)).toContain('node_modules')
    expect(result.error).toBeUndefined()
  }, SPAWN_TEST_TIMEOUT_MS)

  it('失败时保留结构化 stderr 与稳定错误码', async () => {
    const cmd = shellCommand(
      "printf 'Traceback: /tmp/x.py:3\\nValueError: bad\\n' >&2; exit 1",
      `${writeStderr('Traceback: /tmp/x.py:3')}; [Console]::Error.Write([char]10); ${writeStderr('ValueError: bad')}; exit 1`
    )
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(result).toMatchObject({ success: false, error: 'SHELL_PROCESS_EXIT', data: { exitCode: 1, status: 'failed' } })
    expect(String(result.data?.stderr)).toContain('ValueError: bad')
    expect(String(result.data?.stderr)).toContain('<path:redacted>')
  }, SPAWN_TEST_TIMEOUT_MS)

  it('外部 signal 终止不降级为普通 exit code 失败', async () => {
    if (isWindows) return
    const result = await runShellExecutor.execute({ command: 'kill -TERM $$' }, baseCtx(workDir, userDataDir))
    expect(result).toMatchObject({ success: false, error: 'SHELL_PROCESS_EXIT', data: { status: 'signalled', exitCode: null, terminationReason: 'external_signal', signal: 'SIGTERM' } })
  }, SPAWN_TEST_TIMEOUT_MS)

  it('executable 不可用时返回稳定错误码与无进程结果', async () => {
    // Windows 自定义 executable 在 plan 阶段即被拒绝（见下一条用例），这条契约只在 POSIX 可复现。
    if (isWindows) return
    const ctx = { ...baseCtx(workDir, userDataDir), shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, executable: path.join(workDir, 'missing-shell') } }
    const result = await runShellExecutor.execute({ command: 'echo never' }, ctx)
    expect(result).toMatchObject({ success: false, error: 'SHELL_EXECUTABLE_UNAVAILABLE', data: { processResult: null } })
    expect(logShellAgentEvent).toHaveBeenCalledWith(
      'error',
      'shell.exec.plan_failed',
      expect.objectContaining({ commandFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })
    )
    expect(logShellAgentEvent).not.toHaveBeenCalledWith('info', 'shell.exec.spawned', expect.anything())
  })

  it('正常结束时成对移除 AbortSignal 监听器', async () => {
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const result = await runShellExecutor.execute(
      { command: 'echo listener-balance' },
      { ...baseCtx(workDir, userDataDir), signal: controller.signal }
    )

    expect(result.success).toBe(true)
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      addEventListener.mock.calls[0]?.[1]
    )
  }, SPAWN_TEST_TIMEOUT_MS)

  it('完成日志不记录完整 stdout/stderr，只记录摘要和统计信息', async () => {
    const secret = 'sensitive-output-' + 'x'.repeat(400)
    await runShellExecutor.execute(
      { command: shellCommand(`printf '${secret}'`, writeStdout(secret)) },
      baseCtx(workDir, userDataDir)
    )
    const finish = vi.mocked(logShellAgentEvent).mock.calls.find(([, event]) => event === 'shell.exec.finish')
    expect(finish).toBeTruthy()
    const fields = finish?.[2] as Record<string, unknown>
    expect(fields.stdout).toBeUndefined()
    expect(fields.stderr).toBeUndefined()
    expect(fields.stdoutBytes).toBe(secret.length)
    expect(fields.stdoutSummary).toBeUndefined()
    expect(fields.stderrSummary).toBeUndefined()
    expect(String(fields.stdoutSha256)).toMatch(/^[0-9a-f]{64}$/)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('生命周期日志不记录原始命令、工作目录或敏感输出', async () => {
    const payload = 'API_KEY=secret-token /Users/alice/private.txt Bearer abc.def'
    const command = shellCommand(`printf '${payload}'`, writeStdout(payload))
    await runShellExecutor.execute({ command, description: '/Users/alice/private description' }, baseCtx(workDir, userDataDir))
    for (const [, event, fields] of vi.mocked(logShellAgentEvent).mock.calls) {
      if (!event.startsWith('shell.exec.')) continue
      const serialized = JSON.stringify(fields)
      expect(serialized).not.toContain(command)
      expect(serialized).not.toContain(workDir)
      expect(serialized).not.toContain('secret-token')
      expect(serialized).not.toContain('abc.def')
      expect(serialized).not.toContain('/Users/alice/private.txt')
    }
  }, SPAWN_TEST_TIMEOUT_MS)

  it('生命周期日志不记录自定义 shell 可执行文件绝对路径或裸秘密', async () => {
    const executable = path.join(workDir, 'private-shell')
    const ctx = { ...baseCtx(workDir, userDataDir), shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, executable } }
    await runShellExecutor.execute(
      { command: shellCommand("printf 'hunter2'", writeStdout('hunter2')) },
      ctx
    )
    for (const [, event, fields] of vi.mocked(logShellAgentEvent).mock.calls) {
      if (!event.startsWith('shell.exec.')) continue
      const serialized = JSON.stringify(fields)
      expect(serialized).not.toContain(executable)
      expect(serialized).not.toContain('hunter2')
    }
  }, SPAWN_TEST_TIMEOUT_MS)

  it('waits for long command to finish in foreground', async () => {
    const cmd = shellCommand('sleep 2', 'Start-Sleep -Seconds 2')
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(result.success).toBe(true)
    expect(result.data?.exitCode).toBe(0)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('reports timeout instead of user cancel when command exceeds timeout', async () => {
    const longCmd = shellCommand('sleep 5', 'Start-Sleep -Seconds 5')
    const ctx = baseCtx(workDir, userDataDir)
    const addEventListener = vi.spyOn(ctx.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(ctx.signal, 'removeEventListener')
    const result = await runShellExecutor.execute(
      { command: longCmd, timeout: 1 },
      ctx
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe('SHELL_TIMEOUT')
    expect(result.userMessage).toMatch(/命令执行超时（1 秒）/)
    expect(result.data?.interrupted).toBe(true)
    expect(result.data?.terminationSignal).toBe(isWindows ? 'taskkill' : 'SIGTERM')
    expect(result.data?.treeKillVerified).toBe(true)
    expect(result.data?.terminationErrorCode).toBeUndefined()
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('macOS 独立进程组可回收 Shell 派生的孙进程', async () => {
    if (process.platform !== 'darwin') return
    const pidFile = path.join(workDir, 'child.pid')
    const result = await runShellExecutor.execute({
      command: `sleep 30 & echo $! > '${pidFile}'; wait`,
      timeout: 1
    }, baseCtx(workDir, userDataDir))
    expect(result.error).toBe('SHELL_TIMEOUT')
    expect(result.userMessage).toMatch(/命令执行超时/)
    const childPid = Number((await fs.readFile(pidFile, 'utf8')).trim())
    expect(childPid).toBeGreaterThan(0)
    expect(() => process.kill(childPid, 0)).toThrow()
  }, 20_000)

  it('reports user cancel when abort signal fires', async () => {
    const longCmd = shellCommand('sleep 30', 'Start-Sleep -Seconds 30')
    const controller = new AbortController()
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      signal: controller.signal
    }
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = runShellExecutor.execute({ command: longCmd, timeout: 300 }, ctx)
    await new Promise((r) => setTimeout(r, 500))
    controller.abort()
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toBe('SHELL_CANCELLED')
    expect(result.userMessage).toBe('用户取消执行')
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('spawn error 后仍关闭 artifact writer 并收敛返回', async () => {
    // cwd 不存在时 spawn 必然失败，且不依赖任何平台特有的 executable 配置分支。
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      workDir: path.join(workDir, 'missing-cwd')
    }
    const result = await runShellExecutor.execute({ command: 'echo never-runs' }, ctx)
    expect(result.success).toBe(false)
    expect(result.data).toMatchObject({ code: 'SHELL_SPAWN_ERROR', caseId: 'SHELL-LIFECYCLE-003' })
    expect(logShellAgentEvent).toHaveBeenCalledWith(
      'error',
      'shell.exec.error',
      expect.objectContaining({ spawnError: expect.any(String) })
    )
    expect(result.data?.outputPersistErrorCode).toBeUndefined()
    expect(result.duration).toBeGreaterThanOrEqual(0)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('Windows 上自定义非 PowerShell executable 在 spawn 前被拒绝为需重新选择', async () => {
    if (!isWindows) return
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      shellConfig: {
        ...baseCtx(workDir, userDataDir).shellConfig,
        executable: path.join(workDir, 'missing-shell-executable')
      }
    }
    const result = await runShellExecutor.execute({ command: 'echo never-runs' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBe('SHELL_PLAN_INVALID')
    expect(result.data).toMatchObject({
      code: 'SHELL_PLAN_INVALID',
      reason: 'custom-executable',
      caseId: 'SHELL-PLAN-001',
      processResult: null
    })
    expect(logShellAgentEvent).toHaveBeenCalledWith(
      'error',
      'shell.exec.plan_failed',
      expect.objectContaining({
        error: 'SHELL_LEGACY_CONFIG_UNSUPPORTED',
        commandFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    )
    expect(logShellAgentEvent).not.toHaveBeenCalledWith('info', 'shell.exec.spawned', expect.anything())
  })

  it('执行入口在当前 shell 配置过期时返回 PLAN_STALE 且不 spawn', async () => {
    const plannedCtx = baseCtx(workDir, userDataDir)
    const prepared = await planRunShellExecution({ command: 'echo should-not-spawn' }, plannedCtx)
    const currentCtx = {
      ...plannedCtx,
      shellConfig: { ...plannedCtx.shellConfig, maxInlineOutputBytes: 2048 }
    }
    const result = await executePreparedShellExecution(prepared, currentCtx, Date.now(), {
      requestId: currentCtx.requestId,
      sessionId: currentCtx.sessionId,
      toolUseId: currentCtx.toolUseId,
      command: prepared.command
    })
    expect(result).toMatchObject({ success: false, error: 'PLAN_STALE' })
    expect(logShellAgentEvent).not.toHaveBeenCalledWith('info', 'shell.exec.spawned', expect.anything())
  })

  it('persists large output when truncated', async () => {
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      shellConfig: {
        enabled: true,
        shellDefaultTimeoutSec: 300,
        maxInlineOutputBytes: 32
      }
    }
    const big = 'x'.repeat(200)
    await fs.writeFile(path.join(workDir, 'big.txt'), big, 'utf8')
    const cmd = shellCommand('cat big.txt', 'Get-Content -Raw big.txt')
    const result = await runShellExecutor.execute({ command: cmd }, ctx)
    expect(result.success).toBe(true)
    expect(result.data?.truncated).toBe(true)
    expect(result.data?.persistedOutputPath).toBeTruthy()
    const content = await fs.readFile(String(result.data?.persistedOutputPath), 'utf8')
    expect(content).toContain(big)
    expect(result.data?.outputArtifactBytes).toBe(content.length)
    expect(result.data?.outputArtifactSha256).toBe(createHash('sha256').update(content).digest('hex'))
  }, SPAWN_TEST_TIMEOUT_MS)

  it('恶意 toolUseId 只能生成 shell-output 根目录内的 hash artifact 文件', async () => {
    const maliciousId = '../outside/absolute\\name'
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      toolUseId: maliciousId,
      shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, maxInlineOutputBytes: 32 }
    }
    const payload = 'y'.repeat(200)
    const result = await runShellExecutor.execute(
      { command: shellCommand(`printf '${payload}'`, writeStdout(payload)) },
      ctx
    )
    const artifactPath = String(result.data?.persistedOutputPath)
    expect(artifactPath).toMatch(new RegExp(`^${escapePathForRegExp(userDataDir)}[\\\\/]shell-output[\\\\/][0-9a-f]{64}\\.log$`))
    expect(path.basename(artifactPath)).not.toContain('..')
  }, SPAWN_TEST_TIMEOUT_MS)

  it('落盘失败时仍返回进程结果和结构化 OUTPUT_PERSIST_FAILED', async () => {
    const openSpy = vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('artifact directory is not writable'))
    try {
      const ctx = {
        ...baseCtx(workDir, userDataDir),
        shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, maxInlineOutputBytes: 32 }
      }
      const payload = 'x'.repeat(200)
      const result = await runShellExecutor.execute(
        { command: shellCommand(`printf '${payload}'`, writeStdout(payload)) },
        ctx
      )
      expect(result.success).toBe(true)
      expect(String(result.data?.stdout)).toContain('xxxxxxxx')
      expect(result.data?.outputPersistErrorCode).toBe('OUTPUT_PERSIST_FAILED')
      expect(result.data?.caseId).toBe('SHELL-OUTPUT-002')
      expect(result.data?.persistedOutputPath).toBeUndefined()
    } finally {
      openSpy.mockRestore()
    }
  }, SPAWN_TEST_TIMEOUT_MS)

  it('sends progress when stderr receives data', async () => {
    const cmd = shellCommand('echo stderr-only >&2', writeStderr('stderr-only'))
    const ctx = baseCtx(workDir, userDataDir)
    await runShellExecutor.execute({ command: cmd }, ctx)
    const progressCalls = vi.mocked(ctx.sendProgress).mock.calls
    expect(progressCalls.some(([, payload]) => progressPayloadText(payload).includes('stderr-only'))).toBe(true)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('progress IPC 抛异常时仍然收敛并返回进程结果', async () => {
    const ctx = baseCtx(workDir, userDataDir)
    const diagnostic = vi.fn()
    ctx.sendProgress.mockImplementation(() => { throw new Error('renderer gone') })
    ctx.recordDiagnostic = diagnostic
    const result = await runShellExecutor.execute({ command: 'echo progress-failure-isolated' }, ctx)
    expect(result.success).toBe(true)
    expect(String(result.data?.stdout)).toContain('progress-failure-isolated')
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'SHELL_PROGRESS_SEND_FAILED' }))
  }, SPAWN_TEST_TIMEOUT_MS)

  it('stdout/stderr 同时输出时分别保留且不会覆盖', async () => {
    const cmd = shellCommand(
      'printf out; printf err >&2',
      `${writeStdout('out')}; ${writeStderr('err')}`
    )
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(String(result.data?.stdout)).toContain('out')
    expect(String(result.data?.stderr)).toContain('err')
  }, SPAWN_TEST_TIMEOUT_MS)

  it('高频输出时 progress IPC 事件数量受每秒预算限制', async () => {
    const cmd = shellCommand('yes x | head -n 5000', 'Write-Output (1..5000)')
    const ctx = baseCtx(workDir, userDataDir)
    await runShellExecutor.execute({ command: cmd }, ctx)
    expect(vi.mocked(ctx.sendProgress).mock.calls.length).toBeLessThanOrEqual(22)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('超过执行输出上限时终止进程并返回 OUTPUT_LIMIT_REACHED', async () => {
    const cmd = shellCommand('yes x | head -c 2200000', "Write-Output ('x' * 3000000)")
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(result.success).toBe(false)
    expect(result.error).toBe('OUTPUT_LIMIT_REACHED')
    expect(result.data?.outputLimitReached).toBe(true)
    expect(result.data?.truncated).toBe(true)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('sends raw progress in terminal output mode', async () => {
    const cmd = 'echo raw-progress'
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      shellOutputMode: 'terminal' as const,
      shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, outputMode: 'terminal' as const }
    }
    await runShellExecutor.execute({ command: cmd }, ctx)
    const progressCalls = vi.mocked(ctx.sendProgress).mock.calls
    expect(
      progressCalls.some(([, payload]) =>
        typeof payload === 'object' && payload && ('rawDelta' in payload || 'raw' in payload)
      )
    ).toBe(true)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('sends decodable multi-chunk raw tail in terminal mode', async () => {
    const cmd = shellCommand('printf chunk1; printf chunk2', 'Write-Output chunk1; Write-Output chunk2')
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      shellOutputMode: 'terminal' as const,
      shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, outputMode: 'terminal' as const }
    }
    await runShellExecutor.execute({ command: cmd }, ctx)
    const rawPayloads = vi
      .mocked(ctx.sendProgress)
      .mock.calls.flatMap(([, payload]) => {
        if (!payload || typeof payload !== 'object') return []
        if ('rawDelta' in payload && payload.rawDelta) return [String(payload.rawDelta)]
        if ('raw' in payload && payload.raw) return [String(payload.raw)]
        return []
  })

    expect(rawPayloads.length).toBeGreaterThan(0)
    const accumulated = rawPayloads.reduce((acc, delta) => appendProgressOutputRaw(acc, delta), '')
    const decoded = new TextDecoder().decode(decodeProgressRawTail(accumulated))
    expect(decoded).toMatch(/chunk1/)
    expect(decoded).toMatch(/chunk2/)
    expect(decoded.match(/chunk1/g)?.length).toBe(1)
    expect(decoded.match(/chunk2/g)?.length).toBe(1)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('terminal pending raw delta 在节流期间保持 64 KiB 上限', async () => {
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      shellOutputMode: 'terminal' as const,
      shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, outputMode: 'terminal' as const }
    }
    const command = shellCommand('yes x | head -c 200000', "Write-Output ('x' * 200000)")
    await runShellExecutor.execute({ command }, ctx)
    const rawPayloadSizes = vi.mocked(ctx.sendProgress).mock.calls.flatMap(([, payload]) => {
      if (!payload || typeof payload !== 'object' || !('rawDelta' in payload)) return []
      const rawDelta = (payload as { rawDelta?: unknown }).rawDelta
      return typeof rawDelta === 'string' ? [Buffer.from(rawDelta, 'base64').length] : []
    })
    expect(rawPayloadSizes.length).toBeGreaterThan(0)
    expect(Math.max(...rawPayloadSizes)).toBeLessThanOrEqual(PROGRESS_RAW_MAX_BYTES)
  }, SPAWN_TEST_TIMEOUT_MS)

  it('在当前 macOS Bash profile 下于 spawn 前拒绝明显 PowerShell 语法并提供重试熔断信号', async () => {
    if (isWindows) return
    const command = 'Get-ChildItem .'
    const first = await runShellExecutor.execute({ command }, baseCtx(workDir, userDataDir))
    expect(first.success).toBe(false)
    expect(first.error).toBe('SHELL_DIALECT_MISMATCH')
    expect(first.data).toMatchObject({ code: 'SHELL_DIALECT_MISMATCH', expectedDialect: 'posix-bash', retryCount: 1, retryExhausted: false })
    const second = await runShellExecutor.execute({ command }, baseCtx(workDir, userDataDir))
    expect(second.data).toMatchObject({ retryCount: 2, retryExhausted: true })
  })

  it('在当前 Windows PowerShell profile 下于 spawn 前拒绝明显 POSIX 语法并提供重试熔断信号', async () => {
    if (!isWindows) return
    const command = 'export FOO=1 && echo $FOO'
    const first = await runShellExecutor.execute({ command }, baseCtx(workDir, userDataDir))
    expect(first.success).toBe(false)
    expect(first.error).toBe('SHELL_DIALECT_MISMATCH')
    expect(first.data).toMatchObject({
      code: 'SHELL_DIALECT_MISMATCH',
      expectedDialect: 'windows-powershell',
      retryCount: 1,
      retryExhausted: false
    })
    expect(logShellAgentEvent).not.toHaveBeenCalledWith('info', 'shell.exec.spawned', expect.anything())
    const second = await runShellExecutor.execute({ command }, baseCtx(workDir, userDataDir))
    expect(second.data).toMatchObject({ retryCount: 2, retryExhausted: true })
  })
})
