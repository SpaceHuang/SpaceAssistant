import path from 'path'
import { resolveDbPath, resolveJsonPathForDb } from './jsonSnapshot'
import { migrateFromJsonIfNeeded } from './migrateFromJson'
import { openSqliteDatabase, type AppDatabase } from './sqliteStore'
import { migrateThinkingEffortConfig } from './thinkingEffortMigration'

export type { AppDatabase } from './sqliteStore'
export type { StoredMessage } from './types'
// 事务入口与 changes 转换 helper 的对外桶导出；实现位于 ./transaction（canonical 路径）。
export { openSqliteDatabase, openSqliteDatabaseReadOnly, getDbConnection } from './sqliteStore'
export { changesToNumber, runInTransaction } from './transaction'
export { listImInboxMessages } from './imInbox'
export type { ImInboxMessage } from './imInbox'

// 全局配置归属仍通过数据库 composition 桶暴露；会话与 turn 操作须从其具体 owner 导入。
export {
  deleteConfigValue,
  getConfigValue,
  setConfigValue
} from './operations'

export function openDatabase(inputPath: string): AppDatabase {
  if (inputPath === ':memory:') {
    const memoryDb = openSqliteDatabase(':memory:')
    // §8.1：全局档位启动迁移（幂等；已合法时不写）
    migrateThinkingEffortConfig(memoryDb)
    return memoryDb
  }
  const dbPath = resolveDbPath(inputPath)
  const db = openSqliteDatabase(dbPath)
  const jsonPath = resolveJsonPathForDb(dbPath)
  migrateFromJsonIfNeeded(db, jsonPath)
  // §8.1：全局档位启动迁移须在旧 JSON 导入之后——导入的 thinkingEnabled 同样走等价推导
  migrateThinkingEffortConfig(db)
  return db
}

export function getDefaultDbPath(userData: string): string {
  return path.join(userData, 'spaceassistant-data.db')
}

export { ackImInboxMessage, appendImInboxMessage, appendImInboxMessageWithWakeEvent, claimImInboxMessage, releaseImInboxMessage, renewImInboxClaim } from './imInbox'
export type { AppendImInboxMessageInput, AppendImInboxMessageResult, AppendImInboxMessageWithWakeEventResult, ClaimedImInboxMessage, ImInboxChannel } from './imInbox'
export { ackWakeEvent, ackWakeEventInRun, appendWakeEvent, claimWakeEvent, claimWakeEvents, clearWakeEventRetryState, continueWorkflow, finalizeWakeEvents, getWakeEventRecoveryDelayMs, listClaimableWakeEventIds, listRecoverableWakeSessionIds, listWakeEvents, readWakeEvent, readWakeEventRetryState, releaseWakeEventClaimsForRetry, saveWakeEventRetryState, waitForEvent } from './wakeEvents'
export type { AppendWakeEventResult, ClaimedWakeEventSet, WaitForEventInput } from './wakeEvents'
