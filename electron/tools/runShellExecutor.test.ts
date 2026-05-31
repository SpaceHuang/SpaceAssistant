import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runShellExecutor, resolveShellSpawnSpec } from './runShellExecutor'
import { appendProgressOutputRaw, decodeProgressRawTail } from '../../src/shared/terminalScrollback'

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
      expect(spec.shellId).toBe('cmd')
    } else {
      expect(spec.shellId).toBe('bash')
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
    expect(logShellAgentEvent).toHaveBeenCalledWith('info', 'shell.exec.start', expect.objectContaining({ command: 'echo hello' }))
    expect(logShellAgentEvent).toHaveBeenCalledWith('info', 'shell.exec.spawned', expect.any(Object))
    expect(logShellAgentEvent).toHaveBeenCalledWith(
      'info',
      'shell.exec.finish',
      expect.objectContaining({ success: true, exitCode: 0 })
    )
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
    const result = await runShellExecutor.execute(
      { command: longCmd, timeout: 1 },
      baseCtx(workDir, userDataDir)
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/命令执行超时（1 秒）/)
    expect(result.error).not.toBe('用户取消执行')
    expect(result.data?.interrupted).toBe(true)
  }, 20_000)

  it('reports user cancel when abort signal fires', async () => {
    const longCmd =
      process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30'
    const controller = new AbortController()
    const ctx = {
      ...baseCtx(workDir, userDataDir),
      signal: controller.signal
    }
    const pending = runShellExecutor.execute({ command: longCmd, timeout: 300 }, ctx)
    await new Promise((r) => setTimeout(r, 500))
    controller.abort()
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toBe('用户取消执行')
  }, 20_000)

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
  }, 20_000)

  it('sends progress when stderr receives data', async () => {
    const cmd = process.platform === 'win32' ? 'echo stderr-only 1>&2' : 'echo stderr-only >&2'
    const ctx = baseCtx(workDir, userDataDir)
    await runShellExecutor.execute({ command: cmd }, ctx)
    const progressCalls = vi.mocked(ctx.sendProgress).mock.calls
    expect(progressCalls.some(([, payload]) => progressPayloadText(payload).includes('stderr-only'))).toBe(true)
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
  }, 20_000)
})
