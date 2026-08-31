import type {
  CacheKey,
  DecisionCacheEntry,
  DecisionCacheView
} from '../../src/shared/confirmation/types'
import { normalizeShellSignature } from './extractors/commandSequenceExtractor'

export interface LegacyExemptionAdapterDeps {
  /** shell 信任命令（持久，shellConfig.trustedCommands）。 */
  shellTrustedCommands?: string[]
  /** 浏览器持久域名信任（browserConfig.trustedDomains）。 */
  browserTrustedDomains?: string[]
  /** 浏览器 act 持久域名信任（browserConfig.actTrustedDomains）。 */
  actTrustedDomains?: string[]
  /** 浏览器会话级 act 域名信任判定（会话级内存态）。 */
  isBrowserSessionActTrusted?: (sessionId: string, host: string) => boolean
  /** MCP 会话信任判定（会话级内存态）。 */
  isMcpSessionTrusted?: (sessionId: string, serverId: string, toolName: string) => boolean
}

/**
 * P1 决策缓存只读视图：包住四类存量豁免存储
 * （shell 信任命令、browser 持久域名信任、会话级 act 域名信任、MCP 会话信任；grant 不在其列）。
 *
 * 签名规范化逻辑落在此层：缓存键一律取事实的规范化签名，防止构造变体绕过（§9 变体绕过测试集）。
 * P3 将替换为 SqliteDecisionCache，接口不变，策略层与主循环零改动。
 */
export class LegacyExemptionAdapter implements DecisionCacheView {
  constructor(private readonly deps: LegacyExemptionAdapterDeps) {}

  lookup(key: CacheKey): DecisionCacheEntry | null {
    switch (key.kind) {
      case 'shell-command': {
        if (key.level !== 'exact') return null
        const sig = key.verb
        if (!sig) return null
        const matched = this.deps.shellTrustedCommands?.some((c) => normalizeShellSignature(c) === sig)
        return matched ? this.entry(key, 'allow', 'persistent') : null
      }
      case 'domain': {
        const persistent = this.deps.browserTrustedDomains ?? []
        if (persistent.includes(key.domain) || (this.deps.actTrustedDomains ?? []).includes(key.domain)) {
          return this.entry(key, 'allow', 'persistent')
        }
        if (this.deps.isBrowserSessionActTrusted?.('*', key.domain)) {
          return this.entry(key, 'allow', 'session')
        }
        return null
      }
      case 'mcp-tool': {
        if (this.deps.isMcpSessionTrusted?.('*', key.serverId, key.toolName)) {
          return this.entry(key, 'allow', 'session')
        }
        return null
      }
      default:
        return null
    }
  }

  private entry(key: CacheKey, decision: 'allow' | 'deny', scope: 'session' | 'persistent'): DecisionCacheEntry {
    return {
      id: `legacy-${key.kind}`,
      key,
      decision,
      lane: '*',
      scope,
      createdAt: 0,
      lastHitAt: 0,
      hitCount: 1,
      source: 'migration'
    }
  }
}
