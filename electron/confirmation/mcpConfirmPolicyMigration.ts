import { getConfigValue, getDbConnection, setConfigValue, type AppDatabase } from '../database'
import { runInTransaction } from '../database/transaction'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { PolicyRuleStore } from './policyRuleStore'
import { readPolicyPackages, writePolicyPackages } from './policyRulesRuntime'
import type { AuditSink } from './audit'

/**
 * MCP「调用前确认」per-server 字段收敛迁移（security-policy-single-entry R5）。
 *
 * 背景：per-server `toolConfirmPolicy` 字段已从 schema/UI 全链路删除，改由默认规则
 * `mcp-readonly-allow`（只读注解放行，先于 `mcp-tool-ask`）表达。行为保持迁移：
 * 若任一存量 profile 的持久化原始数据带 `toolConfirmPolicy: 'always'`（即用户显式
 * 要求该 server 的只读注解工具也要确认），则向 policy_rules 写入
 * `mcp-readonly-allow → ask` 覆盖，并把 standard 链路套餐置为 custom（规则覆盖仅在
 * custom 套餐下生效；custom + 仅此一条覆盖与 standard 其余规则行为等价；strict 的
 * allow→ask 上调已天然达成迁移意图、loose 是用户显式宽松选择，均不改写）。
 *
 * 注意：schema 字段删除后 zod 解析会 strip 掉旧字段，必须直接读 `config.mcpServers`
 * 原始 JSON 做宽松解析，不能走 listProfiles / parseMcpServerProfiles。
 *
 * 沿用豁免迁移（exemptionMigrationRunner）的约定：版本门控只跑一次、幂等可重入
 * （覆盖按 rule_id upsert、套餐写回即 custom）、失败不推进版本不阻塞启动。
 */
export const MCP_CONFIRM_POLICY_MIGRATION_VERSION = 1
export const MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY = 'config.mcpConfirmPolicy.migrationVersion'

export interface McpConfirmPolicyMigrationRunDeps {
  /** 测试注入：读取 profile 原始 JSON。默认读 config.mcpServers。 */
  readRawProfilesJson?: () => string | null
  /** 审计出口（缺省不落审计）。 */
  audit?: AuditSink
}

export interface McpConfirmPolicyMigrationRunResult {
  status: 'skipped' | 'done' | 'failed'
  /** 是否检测到需要迁移的 always profile（并写入覆盖）。 */
  migrated: boolean
}

/** 宽松解析存量 profile 原始 JSON：任一条目带 toolConfirmPolicy:'always' 即需迁移。损坏/缺省视为无需迁移。 */
export function rawProfilesContainAlwaysPolicy(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return false
    return parsed.some(
      (p) => p != null && typeof p === 'object' && (p as Record<string, unknown>).toolConfirmPolicy === 'always'
    )
  } catch {
    return false
  }
}

export function runMcpConfirmPolicyMigrationOnce(
  db: AppDatabase,
  deps: McpConfirmPolicyMigrationRunDeps = {}
): McpConfirmPolicyMigrationRunResult {
  const current = Number(getConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY) ?? 0)
  if (current >= MCP_CONFIRM_POLICY_MIGRATION_VERSION) {
    return { status: 'skipped', migrated: false }
  }

  const readRaw = deps.readRawProfilesJson ?? (() => getConfigValue(db, 'config.mcpServers'))

  try {
    const needsMigration = rawProfilesContainAlwaysPolicy(readRaw())
    if (needsMigration) {
      // 覆盖 upsert 幂等。套餐：规则覆盖仅在 custom 下生效，故 standard 链路转 custom
      // （custom + 仅此一条覆盖与 standard 其余规则行为等价）；strict 保持原样（其
      // "allow→ask" 上调已达成迁移意图），loose 是用户显式宽松选择，亦不改写。
      // 多处写入包同一事务：崩溃不留半迁移状态（幂等重试仍可兜底）。
      const conn = getDbConnection(db)
      runInTransaction(conn, () => {
        new PolicyRuleStore(conn).setOverride({
          ruleId: 'mcp-readonly-allow',
          action: 'ask',
          params: {}
        })
        const packages = readPolicyPackages(db)
        for (const lane of ['desktop', 'wechat', 'feishu', 'automation'] as const) {
          if (packages[lane] === 'standard') packages[lane] = 'custom'
        }
        writePolicyPackages(db, packages)
        setConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY, String(MCP_CONFIRM_POLICY_MIGRATION_VERSION))
      })
      deps.audit?.record({
        ts: Date.now(),
        event: 'migration.mcp-confirm-policy',
        lane: 'desktop',
        sessionId: '',
        reason: 'mcp-readonly-allow→ask;packages→custom',
        actor: 'migration'
      })
    } else {
      setConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY, String(MCP_CONFIRM_POLICY_MIGRATION_VERSION))
    }
    logAgentEvent('info', 'confirmation.mcp_confirm_policy_migration.done', { migrated: needsMigration })
    return { status: 'done', migrated: needsMigration }
  } catch (e) {
    // 失败兜底：版本不推进（下次启动重试），不阻塞启动
    logAgentEvent('warn', 'confirmation.mcp_confirm_policy_migration.failed', {
      message: e instanceof Error ? e.message : String(e)
    })
    return { status: 'failed', migrated: false }
  }
}
