export interface ProgressThrottleOptions {
  minIntervalMs: number
  maxEventsPerSecond: number
  minBytes: number
}

/** 纯时间/预算节流器；调用方负责在 flush 时提供最新快照。 */
export class ProgressThrottle {
  private windowStartedAt = 0
  private windowEvents = 0
  private lastSentAt: number | undefined
  private pendingBytes = 0

  constructor(private readonly options: ProgressThrottleOptions) {}

  shouldSend(now: number, bytes = 0): boolean {
    this.pendingBytes += Math.max(0, bytes)
    if (now - this.windowStartedAt >= 1000) {
      this.windowStartedAt = now
      this.windowEvents = 0
    }
    if (this.windowEvents >= this.options.maxEventsPerSecond) return false
    const intervalElapsed = this.lastSentAt === undefined || now - this.lastSentAt >= this.options.minIntervalMs
    if (!intervalElapsed && this.pendingBytes < this.options.minBytes) return false
    this.lastSentAt = now
    this.windowEvents += 1
    this.pendingBytes = 0
    return true
  }
}
