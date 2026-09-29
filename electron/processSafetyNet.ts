type SafetyNetLogger = (event: 'process.unhandled_rejection', detail: { error: string }) => void

/**
 * 进程级 unhandledRejection 安全网（评审 1.1/1.2 的防御纵深）：
 * Node ≥15 默认 throw 模式下，任何逃逸的 rejection 会直接崩溃主进程——所有会话、
 * 确认等待、定时任务一并中断。逐点 .catch 是正解，本安全网保证漏网点只丢一条日志
 * 而不是整个进程。不能替代逐点修复。
 *
 * 返回卸载函数供测试清理。有意不注册 uncaughtException：同步异常后进程状态不可信，
 * 保持 Node 默认（打印并退出）比吞掉继续运行更安全。
 */
export function installProcessSafetyNet(
  log: SafetyNetLogger = (event, detail) => console.error(`[${event}]`, detail.error)
): () => void {
  const handler = (reason: unknown): void => {
    log('process.unhandled_rejection', {
      error: reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    })
  }
  process.on('unhandledRejection', handler)
  return () => process.off('unhandledRejection', handler)
}
