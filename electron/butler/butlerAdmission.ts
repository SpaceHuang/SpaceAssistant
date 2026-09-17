import { logAgentEvent } from '../agentLogger/agentLogger'

/**
 * 管家单入口准入（P4，偏差 23 的显式单例外）：只拦 butlerInvoker 一个入口。
 * - 并发 = 1：同一时间至多一个 automation 回合在跑；
 * - 每小时触发上限（默认 30，可配）：超限立即拒绝；
 * - 处置只有排队（受控上限，超限拒绝）与拒绝；拒绝必落审计（automation.admission.denied）。
 * 不做：配额维度、桌面 / 远程入口接线、交互式优先与嵌套豁免——留给偏差 23 整项关闭时（§11）。
 */

export type ButlerAdmissionOptions = {
  /** 同一时刻至多 N 个 automation 回合；默认 1。 */
  maxConcurrent?: number
  /** 每小时启动上限；默认 30。 */
  hourlyLimit?: number
  /** 排队上限；队列满时新触发拒绝。默认 10。 */
  queueLimit?: number
  /** 时钟注入（测试）；也可用于自定义窗口起点。 */
  now?: () => number
}

export type ButlerAdmissionResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'hourly-limit' | 'queue-full' }

const HOUR_MS = 3_600_000

export class ButlerAdmission {
  private readonly maxConcurrent: number
  private readonly hourlyLimit: number
  private readonly queueLimit: number
  private readonly nowFn: () => number
  private running = 0
  private readonly waiters: Array<() => void> = []
  private windowStart: number
  private windowCount = 0

  constructor(options: ButlerAdmissionOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1)
    this.hourlyLimit = Math.max(1, options.hourlyLimit ?? 30)
    this.queueLimit = Math.max(0, options.queueLimit ?? 10)
    this.nowFn = options.now ?? Date.now
    this.windowStart = this.nowFn()
  }

  private rollWindowIfNeeded(now: number): void {
    if (now - this.windowStart >= HOUR_MS) {
      this.windowStart = now
      this.windowCount = 0
    }
  }

  private finish(): void {
    this.running -= 1
    const next = this.waiters.shift()
    if (next) next()
  }

  async acquire(requestId: string): Promise<ButlerAdmissionResult> {
    const now = this.nowFn()
    this.rollWindowIfNeeded(now)
    // 小时上限按「触发进入系统」计数：排队票据在 acquire 时即占一个配额，
    // 轮到启动时不重复计数（否则窗口切换语义会漂移）。
    if (this.windowCount >= this.hourlyLimit) {
      logAgentEvent('warn', 'automation.admission.denied', {
        requestId,
        reason: 'hourly-limit',
        windowCount: this.windowCount,
        hourlyLimit: this.hourlyLimit
      })
      return { ok: false, reason: 'hourly-limit' }
    }
    this.windowCount += 1
    if (this.running >= this.maxConcurrent) {
      if (this.waiters.length >= this.queueLimit) {
        logAgentEvent('warn', 'automation.admission.denied', {
          requestId,
          reason: 'queue-full',
          queued: this.waiters.length,
          queueLimit: this.queueLimit
        })
        return { ok: false, reason: 'queue-full' }
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
      // 评审 P1：finish() 唤醒等待者时已把 running -1（它释放了自己的票），
      // 被唤醒者此处必须把 running +1 补回——否则每发生一次排队计数永久漂移，并发上限失效。
      this.running += 1
      return { ok: true, release: () => this.finish() }
    }
    this.running += 1
    return { ok: true, release: () => this.finish() }
  }
}
