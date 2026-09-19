import { getConfigValue, setConfigValue, type AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { runInTransaction } from '../database/transaction'

/**
 * confirmMode 退役迁移（desktop-auto-approval 计划 §5.7 / 决策 2 彻底清理）：
 * 老用户 `config.tools` JSON 携带的 `confirmMode` 值已无任何消费者（决策层门控删除、
 * UI 入口更早移除），启动时一次性删除该键。`'direct'` 用户的行为变化 = 写确认卡始终
 * 展示 diff（M1 起 diff 预览由回答者驱动）。版本门控幂等，损坏 JSON fail-safe 跳过。
 */
export const CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION = 1
export const CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION_KEY = 'config.confirmModeRetirement.migrationVersion'

export type ConfirmModeRetirementMigrationResult = { status: 'done' | 'skipped'; migrated: boolean }

/** 宽松解析存量 tools 原始 JSON：含 confirmMode 键即需迁移。损坏/缺省视为无需迁移。 */
export function rawToolsContainConfirmMode(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) && 'confirmMode' in (parsed as Record<string, unknown>)
  } catch {
    return false
  }
}

export function runConfirmModeRetirementMigrationOnce(db: AppDatabase): ConfirmModeRetirementMigrationResult {
  const current = Number(getConfigValue(db, CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION_KEY) ?? 0)
  if (current >= CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION) {
    return { status: 'skipped', migrated: false }
  }
  try {
    const raw = getConfigValue(db, 'config.tools')
    if (rawToolsContainConfirmMode(raw)) {
      const conn = getDbConnection(db)
      runInTransaction(conn, () => {
        const parsed = JSON.parse(raw!) as Record<string, unknown>
        delete parsed.confirmMode
        setConfigValue(db, 'config.tools', JSON.stringify(parsed))
        setConfigValue(db, CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION_KEY, String(CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION))
      })
      return { status: 'done', migrated: true }
    }
    setConfigValue(db, CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION_KEY, String(CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION))
    return { status: 'done', migrated: false }
  } catch {
    // 迁移失败不阻塞启动：版本标记不落盘，下次启动幂等重试；残留键无消费者（fail-safe）
    return { status: 'done', migrated: false }
  }
}
