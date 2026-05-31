import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { createProcessOutputStreamDecoder } from '../processOutputEncoding'
import { killProcessTree, spawnCommandSafe } from '../spawnUtil'
import { describeExitCode } from '../shell/shellExitCodes'
import { logShellAgentEvent } from '../shell/shellAgentLogger'
import { planShellExec, type ShellSpawnSpec } from '../shell/shellExecPlan'
import type { ShellConfig } from '../../src/shared/domainTypes'
import type { ToolExecutionContext, ToolExecutor, ToolExecutorResult } from './types'
import { buildShellEnv, decodeProcessOutput } from '../processOutputEncoding'
import { applyPlaywrightInstallShellEnv } from '../shell/shellSpawnEnv'
import { sanitizeToolOutputText, toToolUserError } from './toolUserErrors'
import { normalizeTerminalOutput } from '../../src/shared/terminalOutputSanitize'
import { PROGRESS_RAW_MAX_BYTES } from '../../src/shared/terminalScrollback'

const PROGRESS_TAIL = 4000
const DEFAULT_IO_MAX = 100 * 1024

function appendRawTailBuffer(prev: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([prev, chunk])
  if (combined.length <= PROGRESS_RAW_MAX_BYTES) return Buffer.from(combined)
  return Buffer.from(combined.subarray(combined.length - PROGRESS_RAW_MAX_BYTES))
}

function shellProgressMessage(stdout: string, stderr: string): string {
  return normalizeTerminalOutput((stdout + stderr).slice(-PROGRESS_TAIL))
}

export type { ShellSpawnSpec } from '../shell/shellExecPlan'

export function resolveShellSpawnSpec(shellConfig?: ShellConfig | null): ShellSpawnSpec {
  const exe = shellConfig?.executable?.trim()
  if (exe) {
    const prefix = shellConfig?.argsPrefix?.length ? shellConfig.argsPrefix : ['-lc']
    return { executable: exe, args: [...prefix, ''], shellId: path.basename(exe) }
  }
  if (process.platform === 'win32') {
    return {
      executable: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', ''],
      shellId: 'cmd'
    }
  }
  return {
    executable: '/bin/bash',
    args: ['-lc', ''],
    shellId: 'bash'
  }
}

function truncateIo(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + '\n[输出被截断]', truncated: true }
}

async function persistLargeOutput(
  userDataDir: string,
  taskId: string,
  stdout: string,
  stderr: string
): Promise<string> {
  const dir = path.join(userDataDir, 'shell-output')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${taskId}.log`)
  await fs.writeFile(filePath, `=== stdout ===\n${stdout}\n\n=== stderr ===\n${stderr}`, 'utf8')
  return filePath
}

export const runShellExecutor: ToolExecutor = {
  name: 'run_shell',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const command = typeof input.command === 'string' ? input.command : ''
    const description = typeof input.description === 'string' ? input.description : undefined
    const shellConfig = ctx.shellConfig
    const timeoutSec =
      typeof input.timeout === 'number' ? input.timeout : shellConfig?.shellDefaultTimeoutSec ?? 300
    const ioMax = shellConfig?.maxInlineOutputBytes ?? DEFAULT_IO_MAX

    const spec = resolveShellSpawnSpec(shellConfig)
    const execPlan = planShellExec(command, ctx.workDir, spec)
    const env = buildShellEnv()
    applyPlaywrightInstallShellEnv(env, command)

    const baseLog = {
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      toolUseId: ctx.toolUseId,
      command,
      description,
      cwd: execPlan.cwd,
      shell: spec.shellId,
      timeoutSec,
      ioMaxBytes: ioMax
    }

    logShellAgentEvent('info', 'shell.exec.start', baseLog)

    return runForeground(command, spec, execPlan, env, ctx, timeoutSec, ioMax, started, baseLog)
  }
}

async function runForeground(
  command: string,
  spec: ShellSpawnSpec,
  execPlan: ReturnType<typeof planShellExec>,
  env: NodeJS.ProcessEnv,
  ctx: ToolExecutionContext,
  timeoutSec: number,
  ioMax: number,
  started: number,
  baseLog: Record<string, unknown>
): Promise<ToolExecutorResult> {
  ctx.sendProgress('shell', '启动命令…')
  const stdoutDecoder = createProcessOutputStreamDecoder()
  const stderrDecoder = createProcessOutputStreamDecoder()
  let stdout = ''
  let stderr = ''
  let fullStdout = ''
  let fullStderr = ''
  let interrupted = false
  let proc: ChildProcess
  let timedOut = false
  const terminalMode = ctx.shellOutputMode === 'terminal'
  let progressSeq = 0
  let rawTailBuf: Buffer = Buffer.alloc(0)

  const pushProgress = (stdoutSnap: string, stderrSnap: string, rawChunk?: Buffer) => {
    if (terminalMode && rawChunk && rawChunk.length > 0) {
      rawTailBuf = appendRawTailBuffer(rawTailBuf, rawChunk)
      progressSeq += 1
      ctx.sendProgress('shell', { rawDelta: rawChunk.toString('base64'), seq: progressSeq })
      return
    }
    ctx.sendProgress('shell', shellProgressMessage(stdoutSnap, stderrSnap))
  }

  return await new Promise((resolve) => {
    proc = spawn(spec.executable, execPlan.spawnArgs, {
      cwd: execPlan.cwd,
      env,
      windowsHide: true,
      shell: false
    })

    logShellAgentEvent('info', 'shell.exec.spawned', {
      ...baseLog,
      pid: proc.pid ?? null,
      executable: spec.executable
    })

    const onDataOut = (b: Buffer) => {
      const chunk = stdoutDecoder.write(b)
      fullStdout += chunk
      stdout += chunk
      const t = truncateIo(stdout, ioMax)
      stdout = t.text
      pushProgress(stdout, stderr, terminalMode ? b : undefined)
    }
    const onDataErr = (b: Buffer) => {
      const chunk = stderrDecoder.write(b)
      fullStderr += chunk
      stderr += chunk
      const t = truncateIo(stderr, ioMax)
      stderr = t.text
      pushProgress(stdout, stderr, terminalMode ? b : undefined)
    }

    proc.stdout?.on('data', onDataOut)
    proc.stderr?.on('data', onDataErr)

    const killTimer = setTimeout(() => {
      interrupted = true
      timedOut = true
      void killProcessTree(proc)
    }, timeoutSec * 1000)

    const onAbort = () => {
      interrupted = true
      void killProcessTree(proc)
    }
    ctx.signal.addEventListener('abort', onAbort)

    proc.on('error', (err) => {
      clearTimeout(killTimer)
      ctx.signal.removeEventListener('abort', onAbort)
      logShellAgentEvent('error', 'shell.exec.error', {
        ...baseLog,
        pid: proc.pid ?? null,
        spawnError: err.message,
        durationMs: Date.now() - started
      })
      resolve({
        success: false,
        error: toToolUserError(err, { toolName: 'run_shell' }),
        duration: Date.now() - started
      })
    })

    proc.on('close', (code) => {
      clearTimeout(killTimer)
      ctx.signal.removeEventListener('abort', onAbort)
      const tailOut = stdoutDecoder.end()
      const tailErr = stderrDecoder.end()
      fullStdout += tailOut
      fullStderr += tailErr
      stdout += tailOut
      stderr += tailErr

      const outTrunc = truncateIo(fullStdout || stdout, ioMax)
      const errTrunc = truncateIo(fullStderr || stderr, ioMax)
      const truncated = outTrunc.truncated || errTrunc.truncated

      void (async () => {
        let persistedOutputPath: string | undefined
        if (truncated) {
          persistedOutputPath = await persistLargeOutput(
            ctx.userDataDir,
            ctx.toolUseId,
            fullStdout || stdout,
            fullStderr || stderr
          )
        }

        const exitCode = code ?? (interrupted ? null : 1)
        const exitCodeHint = describeExitCode(typeof exitCode === 'number' ? exitCode : undefined)
        const durationMs = Date.now() - started
        const cancelled = ctx.signal.aborted || (interrupted && !timedOut)
        const success = !cancelled && code === 0
        const logLevel = success ? 'info' : timedOut || (typeof exitCode === 'number' && exitCode !== 0) ? 'warn' : 'info'

        logShellAgentEvent(logLevel, 'shell.exec.finish', {
          ...baseLog,
          pid: proc.pid ?? null,
          exitCode,
          exitCodeHint,
          interrupted,
          timedOut,
          cancelled,
          truncated,
          persistedOutputPath,
          stdout: fullStdout || stdout,
          stderr: fullStderr || stderr,
          durationMs,
          success
        })

        const data = {
          stdout: sanitizeToolOutputText(normalizeTerminalOutput(outTrunc.text), 'run_shell'),
          stderr: sanitizeToolOutputText(normalizeTerminalOutput(errTrunc.text), 'run_shell'),
          exitCode,
          interrupted: interrupted || ctx.signal.aborted,
          truncated,
          persistedOutputPath,
          shell: spec.shellId,
          exitCodeHint
        }

        if (ctx.signal.aborted) {
          resolve({
            success: false,
            error: '用户取消执行',
            data,
            duration: Date.now() - started
          })
          return
        }
        if (timedOut) {
          resolve({
            success: false,
            error: `命令执行超时（${timeoutSec} 秒）`,
            data,
            duration: Date.now() - started
          })
          return
        }
        if (code !== 0) {
          resolve({
            success: false,
            error: toToolUserError(new Error(`命令执行失败（退出码: ${code}）\n${errTrunc.text}`), {
              toolName: 'run_shell'
            }),
            data,
            duration: Date.now() - started
          })
          return
        }
        resolve({ success: true, data, duration: Date.now() - started })
      })()
    })
  })
}

/** 测试 shell 可执行路径 */
export async function testShellExecutable(
  executable: string,
  argsPrefix: string[] | undefined,
  cwd: string
): Promise<{ ok: boolean; error?: string }> {
  const spec: ShellSpawnSpec = {
    executable,
    args: argsPrefix?.length ? argsPrefix : process.platform === 'win32' ? ['/d', '/c', ''] : ['-lc', ''],
    shellId: path.basename(executable)
  }
  const execPlan = planShellExec(process.platform === 'win32' ? 'echo ok' : 'echo ok', cwd, spec)
  const spawned = spawnCommandSafe(spec.executable, execPlan.spawnArgs, { cwd: execPlan.cwd, env: buildShellEnv() })
  if ('error' in spawned) return { ok: false, error: spawned.error }
  return new Promise((resolve) => {
    const outBufs: Buffer[] = []
    spawned.proc.stdout?.on('data', (b: Buffer) => {
      outBufs.push(b)
    })
    spawned.proc.on('close', (code) => {
      const out = decodeProcessOutput(Buffer.concat(outBufs))
      resolve(code === 0 && out.includes('ok') ? { ok: true } : { ok: false, error: `退出码 ${code}` })
    })
    spawned.proc.on('error', (e) => resolve({ ok: false, error: e.message }))
  })
}
