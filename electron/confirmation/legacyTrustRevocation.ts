import type { CacheKey } from '../../src/shared/confirmation/types'
import type { AppDatabase } from '../database'
import { listTrustedCommands, removeTrustedCommands } from '../shell/shellCommandTrust'
import { persistBrowserConfig, readBrowserConfigFromDb } from '../browser/browserConfigDb'
import { removeTrustedActDomains, removeTrustedDomains } from '../browser/browserDomainTrust'

export interface LegacyTrustRevocationResult {
  shellRemoved: number
  trustedDomainsRemoved: number
  actTrustedDomainsRemoved: number
}

const NONE: LegacyTrustRevocationResult = {
  shellRemoved: 0,
  trustedDomainsRemoved: 0,
  actTrustedDomainsRemoved: 0
}

/**
 * B6/B7：确认记忆（decision_cache）与旧信任存储（shellConfig.trustedCommands /
 * browser.trustedDomains / actTrustedDomains）是双源——执行侧两处都读。清除确认记忆时
 * 必须联动撤销旧存储中的等价信任，否则出现"清除假象"（UI 已删、信任仍生效且不可见）。
 *
 * 映射规则与迁移方向一致（exemptionMigrationRunner）：
 * - shell-command exact 键 ↔ executable + fixedArgvPrefix 还原的命令签名串；
 * - domain-any-action ↔ trustedDomains；domain+action ↔ actTrustedDomains；
 * - 会话级键（带 sessionId）不对应任何持久配置信任，不动旧存储。
 */
export function revokeLegacyTrustForCacheKey(db: AppDatabase, key: CacheKey): LegacyTrustRevocationResult {
  if (key.kind === 'shell-command' && key.level === 'exact') {
    const targets = listTrustedCommands(db)
      .filter((t) => t.schemaVersion === 2 && Boolean(t.executable))
      .filter((t) => [t.executable!, ...(t.fixedArgvPrefix ?? [])].join(' ') === key.verb)
      .map((t) => t.id)
    if (targets.length === 0) return { ...NONE }
    removeTrustedCommands(db, targets)
    return { ...NONE, shellRemoved: targets.length }
  }
  if (key.kind === 'domain' && !key.sessionId) {
    const browser = readBrowserConfigFromDb(db)
    if (key.level === 'domain-any-action' && browser.trustedDomains.includes(key.domain)) {
      const next = removeTrustedDomains(browser, [key.domain])
      persistBrowserConfig(db, next)
      return { ...NONE, trustedDomainsRemoved: 1 }
    }
    if (key.level === 'domain+action' && browser.actTrustedDomains.includes(key.domain)) {
      const next = removeTrustedActDomains(browser, [key.domain])
      persistBrowserConfig(db, next)
      return { ...NONE, actTrustedDomainsRemoved: 1 }
    }
  }
  return { ...NONE }
}

/** 清空确认记忆时联动清空全部旧信任存储（shell 信任命令 + 两张浏览器域名清单）。 */
export function revokeAllLegacyTrust(db: AppDatabase): LegacyTrustRevocationResult {
  const shellIds = listTrustedCommands(db).map((t) => t.id)
  if (shellIds.length > 0) removeTrustedCommands(db, shellIds)
  const browser = readBrowserConfigFromDb(db)
  const trustedDomainsRemoved = browser.trustedDomains.length
  const actTrustedDomainsRemoved = browser.actTrustedDomains.length
  if (trustedDomainsRemoved > 0 || actTrustedDomainsRemoved > 0) {
    persistBrowserConfig(db, { trustedDomains: [], actTrustedDomains: [] })
  }
  return {
    shellRemoved: shellIds.length,
    trustedDomainsRemoved,
    actTrustedDomainsRemoved
  }
}
