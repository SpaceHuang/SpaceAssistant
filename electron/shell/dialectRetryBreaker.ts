/**
 * 方言错配重试计数器（§4.4 / D-8 定案）。
 * 语义：同 session + profile + signals 组合的错配按次数累计（tripped = count >= 2），
 * 后果是「提示升级」而非阻断——反复撞墙的兜底交给通用机制 REPEATED_SEMANTIC_CALL。
 * 键作用域为会话级：命令改写成功执行后 clearOnSuccess 归零（可恢复性），
 * 会话删除时 forgetSession 一并清理，不再保留「进程级永不清理」语义。
 */
export class DialectRetryBreaker {
  private readonly counts = new Map<string, number>()
  /** 每 session+profile 记录最近一次错配键，供命令改写成功后定向清除。 */
  private readonly lastMismatchKeys = new Map<string, string>()

  private static keyOf(sessionId: string, profileId: string, signals: readonly string[]): string {
    return JSON.stringify([sessionId, profileId, [...signals].sort()])
  }

  record(sessionId: string, profileId: string, signals: readonly string[]): { count: number; tripped: boolean } {
    const key = DialectRetryBreaker.keyOf(sessionId, profileId, signals)
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    this.lastMismatchKeys.set(`${sessionId}\u0000${profileId}`, key)
    return { count, tripped: count >= 2 }
  }

  clear(sessionId: string, profileId: string, signals: readonly string[]): void {
    this.counts.delete(DialectRetryBreaker.keyOf(sessionId, profileId, signals))
  }

  /** 同会话同 profile 的最近一次错配命令被改写成功执行后，清除该键计数（恢复原设计意图）。 */
  clearOnSuccess(sessionId: string, profileId: string): void {
    const scope = `${sessionId}\u0000${profileId}`
    const key = this.lastMismatchKeys.get(scope)
    if (key === undefined) return
    this.counts.delete(key)
    this.lastMismatchKeys.delete(scope)
  }

  /** 会话结束时清理该会话的全部计数。 */
  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of this.counts.keys()) {
      if (key.startsWith(`[${JSON.stringify(sessionId)},`)) this.counts.delete(key)
    }
    for (const key of this.lastMismatchKeys.keys()) {
      if (key.startsWith(prefix)) this.lastMismatchKeys.delete(key)
    }
  }
}

/** 进程级共享实例：planned 转换层（planRejection）与 legacy executor（runShellExecutor）共用同一份计数。 */
export const dialectRetryBreaker = new DialectRetryBreaker()
