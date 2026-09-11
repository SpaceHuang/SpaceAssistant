export type ShutdownCleanupFailure = { task: string; error: unknown }
export type ShutdownCleanupResult = { failures: ShutdownCleanupFailure[] }

/** 独立执行所有清理任务；一个资源失败不能阻断其他资源，也不能留下 rejection。 */
export async function runAllShutdownCleanupTasks(
  tasks: ReadonlyArray<readonly [string, () => Promise<unknown>]>
): Promise<ShutdownCleanupResult> {
  const settled = await Promise.all(tasks.map(async ([task, run]) => {
    try {
      await run()
      return undefined
    } catch (error) {
      return { task, error }
    }
  }))
  return { failures: settled.filter((failure): failure is ShutdownCleanupFailure => Boolean(failure)) }
}
