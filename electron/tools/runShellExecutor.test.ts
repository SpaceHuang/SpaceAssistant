import fs from 'fs/promises'
import { createHash } from 'crypto'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendRawTailBuffer, executePreparedShellExecution, runShellExecutor, resolveShellSpawnSpec } from './runShellExecutor'
import { planRunShellExecution } from './runShellPlan'
import { appendProgressOutputRaw, decodeProgressRawTail } from '../../src/shared/terminalScrollback'
import { PROGRESS_RAW_MAX_BYTES } from '../../src/shared/terminalScrollback'

vi.mock('../shell/shellAgentLogger', () => ({
  logShellAgentEvent: vi.fn()
}))

import { logShellAgentEvent } from '../shell/shellAgentLogger'

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

  it('runs cd /d with quoted path on Windows', async () => {
    if (process.platform !== 'win32') return
    const target = path.join(workDir, 'nested')
    await fs.mkdir(target, { recursive: true })
    const cmd = `cd /d "${target}" && echo nested_ok`
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(result.success).toBe(true)
    expect(String(result.data?.stdout)).toMatch(/nested_ok/)
  }, 20_000)

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
  }, 20_000)

  it('保留包含 node_modules 的成功 stdout，不伪造成失败', async () => {
    const result = await runShellExecutor.execute({ command: "printf 'node_modules dist-electron\\n'" }, baseCtx(workDir, userDataDir))
    expect(result).toMatchObject({ success: true, data: { exitCode: 0, status: 'succeeded' } })
    expect(String(result.data?.stdout)).toContain('node_modules')
    expect(result.error).toBeUndefined()
  }, 20_000)

  it('失败时保留结构化 stderr 与稳定错误码', async () => {
    const result = await runShellExecutor.execute({ command: "printf 'Traceback: /tmp/x.py:3\\nValueError: bad\\n' >&2; exit 1" }, baseCtx(workDir, userDataDir))
    expect(result).toMatchObject({ success: false, error: 'SHELL_PROCESS_EXIT', data: { exitCode: 1, status: 'failed' } })
    expect(String(result.data?.stderr)).toContain('ValueError: bad')
    expect(String(result.data?.stderr)).toContain('<path:redacted>')
  }, 20_000)

  it('外部 signal 终止不降级为普通 exit code 失败', async () => {
    if (process.platform === 'win32') return
    const result = await runShellExecutor.execute({ command: 'kill -TERM $$' }, baseCtx(workDir, userDataDir))
    expect(result).toMatchObject({ success: false, error: 'SHELL_PROCESS_EXIT', data: { status: 'signalled', exitCode: null, terminationReason: 'external_signal', signal: 'SIGTERM' } })
  }, 20_000)

  it('spawn 失败返回稳定错误码与无进程结果', async () => {
    const ctx = { ...baseCtx(workDir, userDataDir), shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, executable: path.join(workDir, 'missing-shell') } }
    const result = await runShellExecutor.execute({ command: 'echo never' }, ctx)
    expect(result).toMatchObject({ success: false, error: 'SHELL_EXECUTABLE_UNAVAILABLE', data: { processResult: null } })
  }, 20_000)

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
  }, 20_000)

  it('完成日志不记录完整 stdout/stderr，只记录摘要和统计信息', async () => {
    const secret = 'sensitive-output-' + 'x'.repeat(400)
    await runShellExecutor.execute({ command: `printf '${secret}'` }, baseCtx(workDir, userDataDir))
    const finish = vi.mocked(logShellAgentEvent).mock.calls.find(([, event]) => event === 'shell.exec.finish')
    expect(finish).toBeTruthy()
    const fields = finish?.[2] as Record<string, unknown>
    expect(fields.stdout).toBeUndefined()
    expect(fields.stderr).toBeUndefined()
    expect(fields.stdoutBytes).toBe(secret.length)
    expect(fields.stdoutSummary).toBeUndefined()
    expect(fields.stderrSummary).toBeUndefined()
    expect(String(fields.stdoutSha256)).toMatch(/^[0-9a-f]{64}$/)
  }, 20_000)

  it('生命周期日志不记录原始命令、工作目录或敏感输出', async () => {
    const command = "printf 'API_KEY=secret-token /Users/alice/private.txt Bearer abc.def'"
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
  }, 20_000)

  it('生命周期日志不记录自定义 shell 可执行文件绝对路径或裸秘密', async () => {
    const executable = path.join(workDir, 'private-shell')
    const ctx = { ...baseCtx(workDir, userDataDir), shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, executable } }
    await runShellExecutor.execute({ command: "printf 'hunter2'" }, ctx)
    for (const [, event, fields] of vi.mocked(logShellAgentEvent).mock.calls) {
      if (!event.startsWith('shell.exec.')) continue
      const serialized = JSON.stringify(fields)
      expect(serialized).not.toContain(executable)
      expect(serialized).not.toContain('hunter2')
    }
  }, 20_000)

  it('waits for long command to finish in foreground', async () => {
    const cmd = process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > nul' : 'sleep 2'
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(result.success).toBe(true)
    expect(result.data?.exitCode).toBe(0)
  }, 20_000)

  it('reports timeout instead of user cancel when command exceeds timeout', async () => {
    const longCmd =
      process.platform === 'win32' ? 'ping -n 5 127.0.0.1 > nul' : 'sleep 5'
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
    expect(result.data?.terminationSignal).toBe(process.platform === 'win32' ? 'taskkill' : 'SIGTERM')
    expect(result.data?.treeKillVerified).toBe(true)
    expect(result.data?.terminationErrorCode).toBeUndefined()
    expect(addEventListener).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
  }, 20_000)

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
    const longCmd =
      process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30'
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
  }, 20_000)

  it('spawn error 后仍关闭 artifact writer 并收敛返回', async () => {
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      shellConfig: {
        ...baseCtx(workDir, userDataDir).shellConfig,
        executable: path.join(workDir, 'missing-shell-executable')
      }
    }
    const result = await runShellExecutor.execute({ command: 'echo never-runs' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBe('SHELL_EXECUTABLE_UNAVAILABLE')
    expect(result.data).toMatchObject({ code: 'SHELL_EXECUTABLE_UNAVAILABLE', caseId: 'SHELL-CAPABILITY-002' })
    expect(logShellAgentEvent).toHaveBeenCalledWith(
      'error',
      'shell.exec.plan_failed',
      expect.objectContaining({ commandFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })
    )
    expect(logShellAgentEvent).not.toHaveBeenCalledWith('info', 'shell.exec.spawned', expect.anything())
    expect(result.duration).toBeGreaterThanOrEqual(0)
  }, 20_000)

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
    const cmd = process.platform === 'win32' ? 'type big.txt' : 'cat big.txt'
    const result = await runShellExecutor.execute({ command: cmd }, ctx)
    expect(result.success).toBe(true)
    expect(result.data?.truncated).toBe(true)
    expect(result.data?.persistedOutputPath).toBeTruthy()
    const content = await fs.readFile(String(result.data?.persistedOutputPath), 'utf8')
    expect(content).toContain(big)
    expect(result.data?.outputArtifactBytes).toBe(content.length)
    expect(result.data?.outputArtifactSha256).toBe(createHash('sha256').update(content).digest('hex'))
  }, 20_000)

  it('恶意 toolUseId 只能生成 shell-output 根目录内的 hash artifact 文件', async () => {
    const maliciousId = '../outside/absolute\\name'
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      toolUseId: maliciousId,
      shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, maxInlineOutputBytes: 32 }
    }
    const result = await runShellExecutor.execute({ command: `printf '${'y'.repeat(200)}'` }, ctx)
    const artifactPath = String(result.data?.persistedOutputPath)
    expect(artifactPath).toMatch(new RegExp(`^${userDataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/shell-output/[0-9a-f]{64}\\.log$`))
    expect(path.basename(artifactPath)).not.toContain('..')
  }, 20_000)

  it('落盘失败时仍返回进程结果和结构化 OUTPUT_PERSIST_FAILED', async () => {
    const openSpy = vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('artifact directory is not writable'))
    try {
      const ctx = {
        ...baseCtx(workDir, userDataDir),
        shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, maxInlineOutputBytes: 32 }
      }
      const result = await runShellExecutor.execute({ command: `printf '${'x'.repeat(200)}'` }, ctx)
      expect(result.success).toBe(true)
      expect(String(result.data?.stdout)).toContain('xxxxxxxx')
      expect(result.data?.outputPersistErrorCode).toBe('OUTPUT_PERSIST_FAILED')
      expect(result.data?.caseId).toBe('SHELL-OUTPUT-002')
      expect(result.data?.persistedOutputPath).toBeUndefined()
    } finally {
      openSpy.mockRestore()
    }
  }, 20_000)

  it('sends progress when stderr receives data', async () => {
    const cmd = process.platform === 'win32' ? 'echo stderr-only 1>&2' : 'echo stderr-only >&2'
    const ctx = baseCtx(workDir, userDataDir)
    await runShellExecutor.execute({ command: cmd }, ctx)
    const progressCalls = vi.mocked(ctx.sendProgress).mock.calls
    expect(progressCalls.some(([, payload]) => progressPayloadText(payload).includes('stderr-only'))).toBe(true)
  }, 20_000)

  it('progress IPC 抛异常时仍然收敛并返回进程结果', async () => {
    const ctx = baseCtx(workDir, userDataDir)
    const diagnostic = vi.fn()
    ctx.sendProgress.mockImplementation(() => { throw new Error('renderer gone') })
    ctx.recordDiagnostic = diagnostic
    const result = await runShellExecutor.execute({ command: 'echo progress-failure-isolated' }, ctx)
    expect(result.success).toBe(true)
    expect(String(result.data?.stdout)).toContain('progress-failure-isolated')
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'SHELL_PROGRESS_SEND_FAILED' }))
  }, 20_000)

  it('stdout/stderr 同时输出时分别保留且不会覆盖', async () => {
    const cmd = process.platform === 'win32'
      ? 'echo out & echo err 1>&2'
      : 'printf out; printf err >&2'
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(String(result.data?.stdout)).toContain('out')
    expect(String(result.data?.stderr)).toContain('err')
  }, 20_000)

  it('高频输出时 progress IPC 事件数量受每秒预算限制', async () => {
    const cmd = process.platform === 'win32'
      ? 'for /L %i in (1,1,5000) do @echo %i'
      : 'yes x | head -n 5000'
    const ctx = baseCtx(workDir, userDataDir)
    await runShellExecutor.execute({ command: cmd }, ctx)
    expect(vi.mocked(ctx.sendProgress).mock.calls.length).toBeLessThanOrEqual(22)
  }, 20_000)

  it('超过执行输出上限时终止进程并返回 OUTPUT_LIMIT_REACHED', async () => {
    const cmd = process.platform === 'win32'
      ? 'for /L %i in (1,1,3000000) do @echo x'
      : 'yes x | head -c 2200000'
    const result = await runShellExecutor.execute({ command: cmd }, baseCtx(workDir, userDataDir))
    expect(result.success).toBe(false)
    expect(result.error).toBe('OUTPUT_LIMIT_REACHED')
    expect(result.data?.outputLimitReached).toBe(true)
    expect(result.data?.truncated).toBe(true)
  }, 20_000)

  it('sends raw progress in terminal output mode', async () => {
    const cmd = process.platform === 'win32' ? 'echo raw-progress' : 'echo raw-progress'
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
  }, 20_000)

  it('sends decodable multi-chunk raw tail in terminal mode', async () => {
    const cmd =
      process.platform === 'win32'
        ? 'echo chunk1 && echo chunk2'
        : 'printf chunk1; printf chunk2'
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
  }, 20_000)

  it('terminal pending raw delta 在节流期间保持 64 KiB 上限', async () => {
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      shellOutputMode: 'terminal' as const,
      shellConfig: { ...baseCtx(workDir, userDataDir).shellConfig, outputMode: 'terminal' as const }
    }
    const command = process.platform === 'win32'
      ? 'for /L %i in (1,1,200000) do @echo x'
      : 'yes x | head -c 200000'
    await runShellExecutor.execute({ command }, ctx)
    const rawPayloadSizes = vi.mocked(ctx.sendProgress).mock.calls.flatMap(([, payload]) => {
      if (!payload || typeof payload !== 'object' || !('rawDelta' in payload)) return []
      const rawDelta = (payload as { rawDelta?: unknown }).rawDelta
      return typeof rawDelta === 'string' ? [Buffer.from(rawDelta, 'base64').length] : []
    })
    expect(rawPayloadSizes.length).toBeGreaterThan(0)
    expect(Math.max(...rawPayloadSizes)).toBeLessThanOrEqual(PROGRESS_RAW_MAX_BYTES)
  }, 20_000)

  it('在当前 macOS Bash profile 下于 spawn 前拒绝明显 PowerShell 语法并提供重试熔断信号', async () => {
    if (process.platform === 'win32') return
    const command = 'Get-ChildItem .'
    const first = await runShellExecutor.execute({ command }, baseCtx(workDir, userDataDir))
    expect(first.success).toBe(false)
    expect(first.error).toBe('SHELL_DIALECT_MISMATCH')
    expect(first.data).toMatchObject({ code: 'SHELL_DIALECT_MISMATCH', expectedDialect: 'posix-bash', retryCount: 1, retryExhausted: false })
    const second = await runShellExecutor.execute({ command }, baseCtx(workDir, userDataDir))
    expect(second.data).toMatchObject({ retryCount: 2, retryExhausted: true })
  })
})
