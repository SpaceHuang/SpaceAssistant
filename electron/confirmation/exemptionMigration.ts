import type { DecisionCacheEntry } from '../../src/shared/confirmation/types'
import { normalizeShellSignature } from './extractors/commandSequenceExtractor'

export interface ExemptionMigrationInput {
  shellTrustedCommands?: string[]
  browserTrustedDomains?: string[]
  actTrustedDomains?: string[]
  /** 其它（如会话级 MCP / act 会话信任运行时注入）额外落库条目。 */
  extra?: DecisionCacheEntry[]
}

/**
 * 把存量豁免（shell 信任命令 / 浏览器持久域名信任）转换为 decision_cache 条目（P3 §5.3）。
 *
 * - shell 信任命令 → shell-command 精确签名键（persistent）；
 * - 浏览器持久域名信任（browserConfig.trustedDomains / actTrustedDomains）→ domain 键（persistent）；
 * - 会话级（MCP 会话信任 / act 会话信任）为运行时内存态，由调用方以 extra 注入（scope=session，
 *   应用启动时清空，见 §5.3 清理钩子）。
 * - 其余额外条目（如 policy_rules 覆盖、migration.* 审计）由调用方封装。
 */
export function buildExemptionMigrationEntries(input: ExemptionMigrationInput): DecisionCacheEntry[] {
  const now = Date.now()
  const entries: DecisionCacheEntry[] = []

  for (const cmd of input.shellTrustedCommands ?? []) {
    const sig = normalizeShellSignature(cmd)
    if (!sig) continue
    entries.push({
      id: `mig-shell-${sig}`,
      key: { kind: 'shell-command', verb: sig, level: 'exact' },
      decision: 'allow',
      lane: '*',
      scope: 'persistent',
      createdAt: now,
      lastHitAt: now,
      hitCount: 0,
      source: 'migration'
    })
  }

  const domains = new Set([...(input.browserTrustedDomains ?? []), ...(input.actTrustedDomains ?? [])])
  for (const domain of domains) {
    if (!domain) continue
    entries.push({
      id: `mig-domain-${domain}`,
      key: { kind: 'domain', domain, level: 'domain-any-action' },
      decision: 'allow',
      lane: '*',
      scope: 'persistent',
      createdAt: now,
      lastHitAt: now,
      hitCount: 0,
      source: 'migration'
    })
  }

  entries.push(...(input.extra ?? []))
  return entries
}

/**
 * 把迁移条目写入 decision_cache（幂等 upsert）。返回成功写入数。
 * 调用方需在写入后落 migration.* 审计事件（§5.6）。
 */
export function migrateExemptionsToCache(
  entries: DecisionCacheEntry[],
  cache: { record: (entry: DecisionCacheEntry) => void }
): number {
  for (const entry of entries) cache.record(entry)
  return entries.length
}
