import type { SqliteDecisionCache } from './sqliteDecisionCache'

export interface CacheMaintenanceResult {
  sessionCleared: number
  dormantCleared: number
}

/**
 * 应用启动时的缓存维护（§5.3）：清空会话级条目（等价内存态"进程消亡即失效"），
 * 并清理过期/休眠条目。由调用方在启动流程中调用一次；会话删除时对目标会话清空
 * 会话级条目（`cache.clearLane('*', 'session')`）。
 */
export function runStartupCacheCleanup(cache: {
  clearAllSession: () => number
  expireDormant: (now?: number) => number
}): CacheMaintenanceResult {
  const sessionCleared = cache.clearAllSession()
  const dormantCleared = cache.expireDormant()
  return { sessionCleared, dormantCleared }
}

export function clearSessionScope(cache: Pick<SqliteDecisionCache, 'clearLane'>): number {
  return cache.clearLane('*', 'session')
}
