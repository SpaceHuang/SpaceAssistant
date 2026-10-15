import { getConfigValue, type AppDatabase } from '../database'
import { mergeWikiConfig, type WikiConfig } from '../../src/shared/domainTypes'

/** config 表的 Wiki 配置键（ipcShared.CONFIG_KEYS.wiki 引用此处；存储键随历史版本固定）。 */
export const WIKI_CONFIG_DB_KEY = 'config.wiki'

/**
 * 从 config 表读 Wiki 配置（叶子实现，无 electron 依赖）——
 * 供 IPC 上下文之外的装配点（butler/approval lane 等）安全复用。
 */
export function readWikiConfig(db: AppDatabase): WikiConfig {
  const raw = getConfigValue(db, WIKI_CONFIG_DB_KEY)
  if (!raw) return mergeWikiConfig(null)
  try {
    return mergeWikiConfig(JSON.parse(raw) as Partial<WikiConfig>)
  } catch {
    return mergeWikiConfig(null)
  }
}
