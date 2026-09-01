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
 * - 浏览器持久域名信任按两张清单分档：trustedDomains → `domain-any-action` 键（navigate 档）、
 *   actTrustedDomains → `domain+action` 键（act 档），persistent（等价现状隔离语义）；
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
    // 档位拆分（等价现状两张独立清单）：navigate 信任（trustedDomains）→ domain-any-action 档；
    // act 信任（actTrustedDomains）→ domain+action 档。两档键互不命中，避免 act 被 navigate 信任放行。
    const levels: Array<'domain-any-action' | 'domain+action'> = []
    if (input.browserTrustedDomains?.includes(domain)) levels.push('domain-any-action')
    if (input.actTrustedDomains?.includes(domain)) levels.push('domain+action')
    for (const level of levels) {
      entries.push({
        id: `mig-domain-${level}-${domain}`,
        key: { kind: 'domain', domain, level },
        decision: 'allow',
        lane: '*',
        scope: 'persistent',
        createdAt: now,
        lastHitAt: now,
        hitCount: 0,
        source: 'migration'
      })
    }
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
