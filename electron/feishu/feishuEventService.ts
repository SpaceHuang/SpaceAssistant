import { type ChildProcess } from 'child_process'
import readline from 'readline'
import type { FeishuEventConnectionState, FeishuEventStatus, FeishuInboundMessage } from '../../src/shared/feishuTypes'
import { parseCompactInboundEvent } from './feishuInboundParser'
import type { LarkCliRunner } from './larkCliRunner'
import { killProcessTree, spawnCommandSafe } from '../spawnUtil'

const BACKOFF_MS = [5000, 10000, 30000, 60000]

export class FeishuEventService {
  private proc: ChildProcess | null = null
  private stdoutReader: readline.Interface | null = null
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
    const rl = this.stdoutReader
    this.proc = null
    this.stdoutReader = null
    rl?.close()
    if (proc) {
      await killProcessTree(proc)
    }
    this.setState('stopped')
  }

  private async spawnSubscribe(): Promise<void> {
    if (this.intentionalStop) return
    this.setState('connecting')
    const cliPath = this.runner.resolveExecutable()
    const args = ['event', '+subscribe', '--event-types', 'im.message.receive_v1', '--compact', '--quiet']
    const spawned = spawnCommandSafe(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    if ('error' in spawned) {
      this.setState('error', spawned.error)
      this.scheduleRestart(1)
      return
    }
    this.proc = spawned.proc
    this.startedAt = Date.now()

    this.stdoutReader?.close()
    const rl = readline.createInterface({ input: this.proc.stdout! })
    this.stdoutReader = rl
    let gotFirstEvent = false;
    rl.on('line', (line) => {
      try {
        const raw = JSON.parse(line) as unknown
        const msg = parseCompactInboundEvent(raw)
        if (msg) {
          this.processedCount++
          this.onMessage(msg)
          if (!gotFirstEvent) {
            gotFirstEvent = true
            this.setState('connected')
          }
          this.emitState()
        }
      } catch {
        /* ignore parse errors */
      }
    })

    this.proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim()
      if (text) this.lastError = text.slice(-500)
    })

    this.proc.on('close', (code) => {
      rl.close()
      if (this.stdoutReader === rl) this.stdoutReader = null
      this.proc = null
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
      this.setState('error', `1 小时内重启次数超过 ${this.maxRestartsPerHour} 次（exit ${exitCode}）`)
      return
    }
    this.restartTimestamps.push(now)
    const delay = BACKOFF_MS[Math.min(this.restartAttempts++, BACKOFF_MS.length - 1)]
    this.setState('connecting', `进程退出 (${exitCode})，${delay / 1000}s 后重连`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.spawnSubscribe()
    }, delay)
  }
}
