import { type ChildProcess, exec } from 'child_process'
import readline from 'readline'
import type { FeishuEventConnectionState, FeishuEventStatus, FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { parseCompactInboundEvent } from './feishuInboundParser'
import type { LarkCliRunner } from './larkCliRunner'
import { killProcessTree, spawnCommandSafe } from '../spawnUtil'
import { logFeishuCliEvent } from './feishuCliLogger'
import { FEISHU_CLI_LINE_PREVIEW_MAX, inboundSummaryForLog, previewText } from './feishuCliLogFields'

const BACKOFF_MS = [5000, 10000, 30000, 60000]

/** 杀掉所有残留的 lark-cli event subscribe 进程，确保 --force 移除后不会因旧连接导致单实例冲突。 */
function killExistingLarkCliEvents(): Promise<void> {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'win32'
        ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*lark-cli*event*subscribe*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`
        : `pkill -f 'lark-cli.*event.*subscribe'`
    exec(cmd, { windowsHide: true }, () => resolve())
  })
}

export class FeishuEventService {
  private proc: ChildProcess | null = null
  private stderrReader: readline.Interface | null = null
  private state: FeishuEventConnectionState = 'stopped'
  private restartAttempts = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalStop = false
  private processedCount = 0
  private startedAt?: number
  private lastError?: string
  private readonly maxRestartsPerHour = 12
  private restartTimestamps: number[] = []

  constructor(
    private runner: LarkCliRunner,
    private onMessage: (msg: FeishuInboundMessage) => void,
    private onStateChange: (s: FeishuEventStatus) => void
  ) {}

  getStatus(): FeishuEventStatus {
    return {
      state: this.state,
      lastError: this.lastError,
      processedCount: this.processedCount,
      startedAt: this.startedAt
    }
  }

  private emitState(): void {
    this.onStateChange(this.getStatus())
  }

  private setState(state: FeishuEventConnectionState, err?: string): void {
    this.state = state
    if (err) this.lastError = err
    logFeishuCliEvent('info', 'feishu.event.state', {
      state,
      lastErrorPreview: this.lastError ? previewText(this.lastError, FEISHU_CLI_LINE_PREVIEW_MAX) : undefined
    })
    this.emitState()
  }

  async start(): Promise<void> {
    this.intentionalStop = false
    this.restartAttempts = 0
    this.restartTimestamps = []
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    await this.spawnSubscribe()
  }

  async stop(): Promise<void> {
    this.intentionalStop = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const proc = this.proc
    const rl = this.stderrReader
    this.proc = null
    this.stderrReader = null
    rl?.close()
    if (proc) {
      await killProcessTree(proc)
    }
    this.setState('stopped')
  }

  private async spawnSubscribe(): Promise<void> {
    if (this.intentionalStop) return
    this.setState('connecting')
    await killExistingLarkCliEvents()
    const cliPath = this.runner.resolveExecutable()
    const args = ['event', '+subscribe', '--event-types', 'im.message.receive_v1', '--compact', '--as', 'bot']
    logFeishuCliEvent('info', 'feishu.event.subscribe_spawn', { cliPath, args })
    const spawned = spawnCommandSafe(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    if ('error' in spawned) {
      this.setState('error', spawned.error)
      this.scheduleRestart(1)
      return
    }
    this.proc = spawned.proc
    this.startedAt = Date.now()

    const stdoutRl = readline.createInterface({ input: this.proc.stdout! })
    const stderrRl = readline.createInterface({ input: this.proc.stderr! })
    this.stderrReader = stderrRl
    let gotFirstEvent = false
    const connectedTimer = setTimeout(() => {
      if (!gotFirstEvent && this.proc) {
        logFeishuCliEvent('info', 'feishu.event.connected_by_timeout', {})
        this.setState('connected')
      }
    }, 3000)

    const handleLine = (source: string, line: string) => {
      try {
        const raw = JSON.parse(line) as unknown
        const msg = parseCompactInboundEvent(raw)
        if (msg) {
          this.processedCount++
          logFeishuCliEvent('info', 'feishu.event.line_parse_ok', inboundSummaryForLog(msg))
          this.onMessage(msg)
          if (!gotFirstEvent) {
            gotFirstEvent = true
            clearTimeout(connectedTimer)
            this.setState('connected')
          }
          this.emitState()
        } else {
          logFeishuCliEvent('warn', 'feishu.event.line_parse_skip', {
            source,
            linePreview: previewText(line, FEISHU_CLI_LINE_PREVIEW_MAX)
          })
        }
      } catch {
        const trimmed = line.trim()
        if (trimmed) {
          this.lastError = trimmed.slice(-500)
          logFeishuCliEvent('info', 'feishu.event.stderr', {
            stderrPreview: previewText(trimmed, FEISHU_CLI_LINE_PREVIEW_MAX)
          })
        }
      }
    }

    stdoutRl.on('line', (line) => handleLine('stdout', line))
    stderrRl.on('line', (line) => handleLine('stderr', line))

    this.proc.on('close', (code) => {
      clearTimeout(connectedTimer)
      stdoutRl.close()
      stderrRl.close()
      this.proc = null
      logFeishuCliEvent(this.intentionalStop ? 'info' : 'warn', 'feishu.event.process_close', {
        exitCode: code ?? 1,
        intentionalStop: this.intentionalStop
      })
      if (this.intentionalStop) {
        this.setState('stopped')
        return
      }
      this.scheduleRestart(code ?? 1)
    })

    this.proc.on('error', (err) => {
      this.lastError = err.message
      this.setState('error', err.message)
    })
  }

  private scheduleRestart(exitCode: number): void {
    const now = Date.now()
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < 3600_000)
    if (this.restartTimestamps.length >= this.maxRestartsPerHour) {
      logFeishuCliEvent('error', 'feishu.event.restart_give_up', { maxRestartsPerHour: this.maxRestartsPerHour })
      this.setState('error', `1 小时内重启次数超过 ${this.maxRestartsPerHour} 次（exit ${exitCode}）`)
      return
    }
    this.restartTimestamps.push(now)
    const delay = BACKOFF_MS[Math.min(this.restartAttempts++, BACKOFF_MS.length - 1)]
    logFeishuCliEvent('warn', 'feishu.event.restart_scheduled', {
      exitCode,
      delayMs: delay,
      attempt: this.restartAttempts,
      restartsInHour: this.restartTimestamps.length
    })
    this.setState('connecting', `进程退出 (${exitCode})，${delay / 1000}s 后重连`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.spawnSubscribe()
    }, delay)
  }
}
