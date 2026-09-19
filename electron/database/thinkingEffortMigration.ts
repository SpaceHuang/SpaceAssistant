import type { AppDatabase } from './sqliteStore'
import { getConfigValue, setConfigValue } from './operations'
import { deriveThinkingEffortFromLegacyEnabled, isThinkingEffort } from '../../src/shared/thinkingEffort'

/**
 * 全局 Thinking 强度等价迁移（需求 §8.1，C4 决策）：
 * 固定在应用启动（数据库打开）时执行一次——`config.thinkingEffort` 缺失或损坏时，
 * 由旧布尔 `config.thinkingEnabled` 推导并落库；旧键保留为只读镜像。
 * `config:get` 读路径只做缺失推导、不落库，避免读副作用与双写窗口。
 */
export function migrateThinkingEffortConfig(db: AppDatabase): void {
  const raw = getConfigValue(db, 'config.thinkingEffort')
  if (isThinkingEffort(raw)) return
  setConfigValue(db, 'config.thinkingEffort', deriveThinkingEffortFromLegacyEnabled(getConfigValue(db, 'config.thinkingEnabled')))
}
