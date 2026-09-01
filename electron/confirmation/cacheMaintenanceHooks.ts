import { getDbConnection, type AppDatabase } from '../database'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { runStartupCacheCleanup, type CacheMaintenanceResult } from './cacheMaintenance'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { AuditedDecisionCache } from './auditedDecisionCache'
import { getSecurityAuditLog } from './audit'
import type { ExecutionLane } from '../../src/shared/confirmation/types'

/**
 * 缓存维护钩子接线（§5.3）：把 cacheMaintenance 的纯函数接到 AppDatabase 上，
 * 供 main.ts 启动流程与 appIpc 会话删除 handler 调用。
 * 清理动作经 AuditedDecisionCache 落 cache.generation-reset / cache.expire-dormant 审计
 * （agentLogger 未初始化时审计出口降级 no-op，不阻断维护）。
 */

function auditedCache(db: AppDatabase, sessionId: string, lane: ExecutionLane): AuditedDecisionCache {
  return new AuditedDecisionCache({
    cache: new SqliteDecisionCache(getDbConnection(db)),
    audit: getSecurityAuditLog(),
    sessionId,
    lane
  })
}

/** 应用启动：清空会话级条目（等价内存态"进程消亡即失效"）+ 过期/休眠清理。失败不阻塞启动。 */
export function runStartupDecisionCacheCleanup(db: AppDatabase): CacheMaintenanceResult | null {
  try {
    const result = runStartupCacheCleanup(auditedCache(db, 'startup', 'desktop'))
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
  // 会话级清除 = clearAllSession（clearLane('*','session') 等价语义），经审计包装落事件
  const cleared = auditedCache(db, sessionId, 'desktop').clearAllSession()
  if (cleared > 0) {
    logAgentEvent('info', 'confirmation.cache.session_scope_cleared', { sessionId, cleared })
  }
  return cleared
}
