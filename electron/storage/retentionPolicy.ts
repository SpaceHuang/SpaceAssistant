import { getConfigValue, type AppDatabase } from '../database'

/**
 * 统一保留策略(S3,偏差 14+24):保留期 / 轮转阈值 / 上限的参数在此枚举——
 * - 策略参数可配(configs 表 key-value);
 * - **显式默认**:缺配置 = 此处显式声明的默认值(基线纪律「不得为缺失的托管值静默默认」),
 *   不是散落在调用点的代码常量兜底;
 * - 非法配置值 fail-closed 收敛显式默认;
 * - 删除动作留痕(审计事件 retention.sessionEvents.cleaned / retention.agentLogs.cleaned,
 *   见 sessionEventRetention.ts / agentLogRetention.ts)。
 */

/** 会话事件台账:台账目录(sessions/)最大保留数,超出按 lastAt 保留最新。 */
const SESSION_EVENT_MAX_SESSIONS_DEFAULT = 100
/** Agent 日志:按日文件的保留天数,超期删除。 */
const AGENT_LOG_RETENTION_DAYS_DEFAULT = 30

/** 策略键 → configs 表键的枚举(可配面)。 */
export const RETENTION_POLICY_CONFIG_KEYS = {
  sessionEventMaxSessions: 'retention.sessionEvent.maxSessions',
  agentLogRetentionDays: 'retention.agentLog.retentionDays'
} as const

/** 策略形状(整数,>=1)。 */
export interface RetentionPolicy {
  sessionEventMaxSessions: number
  agentLogRetentionDays: number
}

/** 显式默认值(缺配置即此值;集中声明、单测锁定)。 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  sessionEventMaxSessions: SESSION_EVENT_MAX_SESSIONS_DEFAULT,
  agentLogRetentionDays: AGENT_LOG_RETENTION_DAYS_DEFAULT
}

/** 配置读取端口(注入,避免本模块耦合具体数据库打开路径)。 */
export interface RetentionPolicyConfigReader {
  getConfigValue(key: string): string | undefined
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 ? value : fallback
}

/** 从 configs 表解析生效保留策略:可配、显式默认、非法收敛(fail-closed)。 */
export function resolveRetentionPolicy(reader: RetentionPolicyConfigReader): RetentionPolicy {
  return {
    sessionEventMaxSessions: parsePositiveInt(
      reader.getConfigValue(RETENTION_POLICY_CONFIG_KEYS.sessionEventMaxSessions),
      DEFAULT_RETENTION_POLICY.sessionEventMaxSessions
    ),
    agentLogRetentionDays: parsePositiveInt(
      reader.getConfigValue(RETENTION_POLICY_CONFIG_KEYS.agentLogRetentionDays),
      DEFAULT_RETENTION_POLICY.agentLogRetentionDays
    )
  }
}

/** 便捷封装:直接从 AppDatabase 读配置解析策略(启动维护 / 日志跨天节流共用)。 */
export function resolveRetentionPolicyFromDb(db: AppDatabase): RetentionPolicy {
  return resolveRetentionPolicy({ getConfigValue: (key) => getConfigValue(db, key) })
}

