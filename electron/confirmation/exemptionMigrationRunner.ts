import { getConfigValue, getDbConnection, setConfigValue, type AppDatabase } from '../database'
import { readBrowserConfigFromDb } from '../browser/browserConfigDb'
import { listTrustedCommands } from '../shell/shellCommandTrust'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { buildExemptionMigrationEntries, migrateExemptionsToCache } from './exemptionMigration'
import { SqliteDecisionCache, canonicalKeyJson } from './sqliteDecisionCache'
import type { AuditSink } from './audit'

/**
 * 存量豁免一次性迁移（§6）：把 shell 信任命令 / 浏览器持久域名信任搬进 decision_cache。
 *
 * - 版本门控沿用 `remoteSecurityConfigVersion` 先例：configs 表记版本号，只跑一次；
 * - 幂等可重入：条目按规范化键 upsert，中断/失败后下次启动重试不会重复；
 * - 失败兜底：保持旧路径可用（版本不推进）、记日志、不阻塞启动；
 * - 迁移过程逐条落 `migration.*` 审计事件（§5.6）。
 */

/** 确认框架豁免迁移版本号。v2：actTrustedDomains 拆分为 domain+action 档（修正 v1 合并档位的语义漂移）。 */
export const CONFIRMATION_EXEMPTION_MIGRATION_VERSION = 2
export const EXEMPTION_MIGRATION_VERSION_KEY = 'config.confirmation.exemptionMigrationVersion'

export interface ExemptionMigrationRunDeps {
  /** 测试注入：读取 shell 信任命令签名串列表。默认读 shellConfig.trustedCommands。 */
  readShellTrustedCommands?: () => string[]
  /** 测试注入：读取浏览器持久域名信任。默认读 browserConfig。 */
  readBrowserTrustedDomains?: () => { trustedDomains: string[]; actTrustedDomains: string[] }
  /** 审计出口（缺省不落审计）。 */
  audit?: AuditSink
}

export interface ExemptionMigrationRunResult {
  status: 'skipped' | 'done' | 'failed'
  written: number
}

export function runExemptionMigrationOnce(
  db: AppDatabase,
  deps: ExemptionMigrationRunDeps = {}
): ExemptionMigrationRunResult {
  const current = Number(getConfigValue(db, EXEMPTION_MIGRATION_VERSION_KEY) ?? 0)
  if (current >= CONFIRMATION_EXEMPTION_MIGRATION_VERSION) {
    return { status: 'skipped', written: 0 }
  }

  const readShell =
    deps.readShellTrustedCommands ??
    (() =>
      listTrustedCommands(db)
        // 只迁移现行生效的结构化（schemaVersion 2）信任条目：executable + fixedArgvPrefix 还原命令签名；
        // 过期/legacy 待审条目本就不能跳过确认，不迁移（避免静默放宽）。
        .filter((t) => t.schemaVersion === 2 && Boolean(t.executable) && !t.expired && !t.legacyStatus)
        .map((t) => [t.executable!, ...(t.fixedArgvPrefix ?? [])].join(' ')))
  const readBrowser =
    deps.readBrowserTrustedDomains ??
    (() => {
      const b = readBrowserConfigFromDb(db)
      return { trustedDomains: b.trustedDomains, actTrustedDomains: b.actTrustedDomains }
    })

  try {
    const browser = readBrowser()
    const entries = buildExemptionMigrationEntries({
      shellTrustedCommands: readShell(),
      browserTrustedDomains: browser.trustedDomains,
      actTrustedDomains: browser.actTrustedDomains
    })
    const cache = new SqliteDecisionCache(getDbConnection(db))
    // v1 → v2 修正：v1 把 actTrustedDomains 并入 domain-any-action 档（navigate 档），
    // 会让 act 被 navigate 信任放行（语义漂移）；这里清除仅属于 act 清单的错档条目。
    if (current === 1) {
      for (const domain of browser.actTrustedDomains) {
        if (!domain || browser.trustedDomains.includes(domain)) continue
        cache.clear({ kind: 'domain', domain, level: 'domain-any-action' })
      }
    }
    const written = migrateExemptionsToCache(entries, cache)
    // 逐条落 migration.* 审计（§5.6）：落规范化键（可对账），不落原始输入
    for (const entry of entries) {
      deps.audit?.record({
        ts: Date.now(),
        event: 'migration.exemption',
        lane: 'desktop',
        sessionId: '',
        cacheKey: canonicalKeyJson(entry.key),
        reason: `${entry.source}:${entry.scope}`,
        actor: 'migration'
      })
    }
    setConfigValue(db, EXEMPTION_MIGRATION_VERSION_KEY, String(CONFIRMATION_EXEMPTION_MIGRATION_VERSION))
    logAgentEvent('info', 'confirmation.exemption_migration.done', { written })
    return { status: 'done', written }
  } catch (e) {
    // 失败兜底：版本不推进（下次启动重试），保持旧路径可用，不阻塞启动（§6）
    logAgentEvent('warn', 'confirmation.exemption_migration.failed', {
      message: e instanceof Error ? e.message : String(e)
    })
    return { status: 'failed', written: 0 }
  }
}
