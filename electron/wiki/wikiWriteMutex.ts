/**
 * 文件粒度异步写互斥（wiki-shared-centralized-storage §9.4）。
 *
 * Map<absPath, Promise> 串行队列：同文件写入按注册顺序（FIFO）串行进入互斥区，
 * 防同文件内容撕裂/交错；不同文件互不阻塞。不防护跨工具调用的 read-modify-write
 * 竞态（lost-update）——该竞态由 SCHEMA 协作守则缓解（§9.4 如实声明）。
 */
const queues = new Map<string, Promise<unknown>>()

/** 在 absPath 的互斥区内执行 fn：同文件按进入顺序串行，失败向调用者传播但不阻塞队列。 */
export async function withWikiWriteMutex<T>(absPath: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = queues.get(absPath) ?? Promise.resolve()
  const run = previous.then(fn)
  // 链上挂一个不 reject 的副本，保持队列存活；run 本身照常向调用者传播失败
  const stored: Promise<unknown> = run.then(
    () => undefined,
    () => undefined
  )
  queues.set(absPath, stored)
  try {
    return await run
  } finally {
    if (queues.get(absPath) === stored) {
      queues.delete(absPath)
    }
  }
}

/** 测试/诊断用：当前仍在互斥队列中的文件数（终态应为 0）。 */
export function pendingWikiWriteCount(): number {
  return queues.size
}

/**
 * 手动进入互斥区（T1.7：执行体读-改-写段无法整体回调包裹时使用）。
 * 返回 release 函数，调用方必须在 finally 中调用；等待前序同文件写完成后才返回。
 */
export async function acquireWikiWriteMutex(absPath: string): Promise<() => void> {
  const previous = queues.get(absPath) ?? Promise.resolve()
  let release!: () => void
  const ticket = new Promise<void>((resolve) => {
    release = resolve
  })
  // 队列持有「前序完成 → 本票放出」的链；release 前后续写不会进入
  const stored: Promise<unknown> = previous.then(() => ticket).then(
    () => undefined,
    () => undefined
  )
  queues.set(absPath, stored)
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    release()
    if (queues.get(absPath) === stored) {
      queues.delete(absPath)
    }
  }
}
