import { getDbConnection, type AppDatabase } from '../database'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { clearSessionScope, runStartupCacheCleanup, type CacheMaintenanceResult } from './cacheMaintenance'
import { SqliteDecisionCache } from './sqliteDecisionCache'

/**
 * 缓存维护钩子接线（§5.3）：把 cacheMaintenance 的纯函数接到 AppDatabase 上，
 * 供 main.ts 启动流程与 appIpc 会话删除 handler 调用。
 */

/** 应用启动：清空会话级条目（等价内存态"进程消亡即失效"）+ 过期/休眠清理。失败不阻塞启动。 */
export function runStartupDecisionCacheCleanup(db: AppDatabase): CacheMaintenanceResult | null {
  try {
    const result = runStartupCacheCleanup(new SqliteDecisionCache(getDbConnection(db)))
    logAgentEvent('info', 'confirmation.cache.startup_cleanup', {
      sessionCleared: result.sessionCleared,
      dormantCleared: result.dormantCleared
    })
    return result
  } catch (e) {
    logAgentEvent('warn', 'confirmation.cache.startup_cleanup_failed', {
      message: e instanceof Error ? e.message : String(e)
    })
    return null
  }
}

/**
 * 会话删除：清空会话级 decision_cache 条目。
 * scope=session 即"进程级"语义（decision_cache 无 sessionId 维度），按 §5.3 既有语义整体清除。
 */
export function clearDecisionCacheOnSessionDelete(db: AppDatabase, sessionId: string): number {
  const cleared = clearSessionScope(new SqliteDecisionCache(getDbConnection(db)))
  if (cleared > 0) {
    logAgentEvent('info', 'confirmation.cache.session_scope_cleared', { sessionId, cleared })
  }
  return cleared
}
