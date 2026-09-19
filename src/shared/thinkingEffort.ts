import type { AgentReasoningEffort } from './agent/invocation'

export type { AgentReasoningEffort }

/**
 * Thinking 强度档位（需求：thinking-effort-settings-requirement.md §4.1）。
 * 复用契约类型 AgentReasoningEffort，不新造枚举；服务端另有 xhigh/max，
 * 本产品不暴露（OQ-1），校验时不得用 SDK 枚举反推服务端能力。
 */
export const THINKING_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const satisfies readonly AgentReasoningEffort[]

export function isThinkingEffort(value: unknown): value is AgentReasoningEffort {
  return typeof value === 'string' && (THINKING_EFFORT_LEVELS as readonly string[]).includes(value)
}

/** 非法 / 缺省档位归一为 fallback；用于 config:get 读兜底与会话字段读归一。 */
export function normalizeThinkingEffort(value: unknown, fallback: AgentReasoningEffort): AgentReasoningEffort {
  return isThinkingEffort(value) ? value : fallback
}

/**
 * 旧布尔开关语义推导（§8.1 迁移等价表）：
 * `false` → off；`true` / 缺失 → medium（与装配层兼容映射 true→medium 完全一致）。
 * 旧存储里布尔以字符串 'true'/'false' 落库，因此同时接受布尔与字符串形态。
 */
export function deriveThinkingEffortFromLegacyEnabled(enabled: unknown): AgentReasoningEffort {
  if (enabled === false || enabled === 'false') return 'off'
  return 'medium'
}

/** 全局档位迁移期双读（§7.1）：新键合法则用新键，否则由旧布尔开关推导。 */
export function resolveGlobalThinkingEffort(rawEffort: unknown, legacyEnabled: unknown): AgentReasoningEffort {
  return normalizeThinkingEffort(rawEffort, deriveThinkingEffortFromLegacyEnabled(legacyEnabled))
}
