import { type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { decodeProcessOutput } from '../processOutputEncoding'
import { spawnCommandSafe } from '../spawnUtil'
import type { FeishuCliDetectResult } from '../../src/shared/feishuTypes'
import { logFeishuCliEvent } from './feishuCliLogger'
import { redactLarkCliArgsForLog } from './feishuCliLogFields'

const MAX_OUTPUT_BYTES = 512 * 1024
const TRUNC_SUFFIX = '\n[输出被截断]'

export interface LarkCliRunOptions {
  args: string[]
  timeoutSec?: number
  cwd?: string
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  signal?: AbortSignal
}

export interface LarkCliRunResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

function appendBufferWithLimit(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number
): Buffer<ArrayBufferLike> {
  const next = Buffer.concat([current, chunk])
  if (next.length <= maxBytes) return next
  return Buffer.concat([next.subarray(0, maxBytes), Buffer.from(TRUNC_SUFFIX, 'utf8')])
}

async function runWhich(cmd: string): Promise<string | null> {
  const spawned = spawnCommandSafe(process.platform === 'win32' ? 'where' : 'which', [cmd])
  if ('error' in spawned) return null
  const proc = spawned.proc
  return new Promise((resolve) => {
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    proc.on('close', (code) => {
      if (code !== 0) resolve(null)
      else resolve(out.trim().split(/\r?\n/)[0] || null)
    })
    proc.on('error', () => resolve(null))
  })
}

export class LarkCliRunner {
  constructor(private resolveCliPathFn: () => string) {}

  resolveExecutable(): string {
    const configured = this.resolveCliPathFn().trim()
    if (configured) return configured
    return process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli'
  }

  async detect(): Promise<FeishuCliDetectResult> {
    const node = await runWhich('node')
    const npm = await runWhich(process.platform === 'win32' ? 'npm.cmd' : 'npm')
    try {
      const r = await this.run({ args: ['--version'], timeoutSec: 10 })
      const version = r.stdout.trim()
      const result: FeishuCliDetectResult = {
        installed: r.exitCode === 0,
        version: version || undefined,
        path: this.resolveExecutable(),
        nodeAvailable: Boolean(node),
        npmAvailable: Boolean(npm)
      }
      logFeishuCliEvent('info', 'feishu.cli.detect', { ...result })
      return result
    } catch {
      const result = { installed: false, nodeAvailable: Boolean(node), npmAvailable: Boolean(npm) }
      logFeishuCliEvent('info', 'feishu.cli.detect', result)
      return result
    }
  }

  run(options: LarkCliRunOptions): Promise<LarkCliRunResult> {
    const { args, timeoutSec = 120, cwd, onStdout, onStderr, signal } = options
    const cliPath = this.resolveExecutable()
    const startedAt = Date.now()
    const { argsRedacted } = redactLarkCliArgsForLog(args)
    logFeishuCliEvent('info', 'feishu.cli.run.start', {
      argsRedacted,
      timeoutSec,
      cwd: cwd ?? undefined
    })
    const env = {
      ...process.env,
      PATH: process.env.PATH ?? process.env.Path ?? ''
    }

    return new Promise((resolve) => {
      let stdoutBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderrBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let timedOut = false
      let settled = false

      const finish = (result: LarkCliRunResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const spawned = spawnCommandSafe(cliPath, args, {
        windowsHide: true,
        cwd: cwd ?? os.homedir(),
        env
      })
      if ('error' in spawned) {
        logFeishuCliEvent('error', 'feishu.cli.run.spawn_error', { error: spawned.error })
        finish({ exitCode: 1, stdout: '', stderr: spawned.error, timedOut: false })
        return
      }

      const proc: ChildProcess = spawned.proc

      const timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGTERM')
        setTimeout(() => proc.kill('SIGKILL'), 500)
      }, timeoutSec * 1000)

      const onAbort = () => {
        proc.kill('SIGTERM')
        setTimeout(() => proc.kill('SIGKILL'), 500)
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      proc.stdout?.on('data', (d: Buffer<ArrayBufferLike>) => {
        stdoutBuf = appendBufferWithLimit(stdoutBuf, d, MAX_OUTPUT_BYTES)
        onStdout?.(d.toString('utf8'))
      })
      proc.stderr?.on('data', (d: Buffer<ArrayBufferLike>) => {
        stderrBuf = appendBufferWithLimit(stderrBuf, d, MAX_OUTPUT_BYTES)
        onStderr?.(d.toString('utf8'))
      })

      const buildResult = (exitCode: number): LarkCliRunResult => ({
        exitCode,
        stdout: decodeProcessOutput(stdoutBuf),
        stderr: decodeProcessOutput(stderrBuf),
        timedOut
      })

      const logDone = (result: LarkCliRunResult) => {
        logFeishuCliEvent(result.exitCode === 0 && !result.timedOut ? 'info' : 'warn', 'feishu.cli.run.done', {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: Date.now() - startedAt,
          stdout: result.stdout,
          stderr: result.stderr
        })
      }

      proc.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        const result = buildResult(code ?? 1)
        logDone(result)
        finish(result)
      })
      proc.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort)
        stderrBuf = appendBufferWithLimit(stderrBuf, Buffer.from(`${err.message}\n`, 'utf8'), MAX_OUTPUT_BYTES)
        const result = buildResult(1)
        logDone(result)
        finish(result)
      })
    })
  }

  runInteractive(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.run({ args, timeoutSec: 600 }).then((r) => ({
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode
    }))
  }
}

export function resolveBundledCliPath(appPath: string): string | null {
  const wrapper = path.join(appPath, 'resources', 'lark-cli', 'wrapper.mjs')
  if (fs.existsSync(wrapper)) return process.execPath
  return null
}
