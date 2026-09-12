import { type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnCommandSafe } from '../spawnUtil'
import { AUTO_CONTRACT } from '../processOutput/contracts'
import { createChildStreamDecoder } from '../processOutput/decodeChildOutput'
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
      // §12-#7：回调与返回值共用同一个流式解码器（契约 auto：第三方 CLI 自行决定编码），
      // 不再出现「UI 看到一份、业务拿到另一份」的两条解码路径。
      const stdoutDecoder = createChildStreamDecoder({ contract: AUTO_CONTRACT })
      const stderrDecoder = createChildStreamDecoder({ contract: AUTO_CONTRACT })
      let stdoutText = ''
      let stderrText = ''
      let stdoutConsumed = 0
      let stderrConsumed = 0
      let stdoutTruncated = false
      let stderrTruncated = false
      let timedOut = false
      let settled = false

      const feed = (
        decoder: ReturnType<typeof createChildStreamDecoder>,
        chunk: Buffer<ArrayBufferLike>,
        target: 'stdout' | 'stderr'
      ): string => {
        const truncated = target === 'stdout' ? stdoutTruncated : stderrTruncated
        if (truncated) return ''
        if (target === 'stdout') stdoutConsumed += chunk.length
        else stderrConsumed += chunk.length
        const delta = decoder.write(chunk)
        if (target === 'stdout') {
          stdoutText += delta
          if (stdoutConsumed > MAX_OUTPUT_BYTES) {
            stdoutTruncated = true
            // MINOR（评审 v2 #8）：截断点先 flush 解码器，别把「已收到但尚未交付」的前导窗口
            // 文本连同后缀一起丢掉；口径与 builtinExecutors 的 ripgrep 截断一致。
            stdoutText += decoder.end()
            stdoutText += TRUNC_SUFFIX
          }
        } else {
          stderrText += delta
          if (stderrConsumed > MAX_OUTPUT_BYTES) {
            stderrTruncated = true
            stderrText += decoder.end()
            stderrText += TRUNC_SUFFIX
          }
        }
        return delta
      }


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
        const delta = feed(stdoutDecoder, d, 'stdout')
        if (delta) onStdout?.(delta)
      })
      proc.stderr?.on('data', (d: Buffer<ArrayBufferLike>) => {
        const delta = feed(stderrDecoder, d, 'stderr')
        if (delta) onStderr?.(delta)
      })

      const buildResult = (exitCode: number): LarkCliRunResult => {
        if (!stdoutTruncated) stdoutText += stdoutDecoder.end()
        if (!stderrTruncated) stderrText += stderrDecoder.end()
        return { exitCode, stdout: stdoutText, stderr: stderrText, timedOut }
      }

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
        if (!stderrTruncated) stderrText += err.message + '\n'
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
