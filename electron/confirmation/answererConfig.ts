import type {
  ConfirmAnswererKind,
  ConfirmAnswererMap,
  ConfirmAnswererPolicy,
  ExecutionLane
} from '../../src/shared/confirmation/types'
import { getConfigValue, type AppDatabase } from '../database'
import { logAgentEvent } from '../agentLogger/agentLogger'

/** 回答者映射持久化 key（configs 表 key-value，JSON 形态的 ConfirmAnswererMap）。 */
export const CONFIRM_ANSWERERS_CONFIG_KEY = 'config.confirmAnswerers'

/** lane → 默认回答者（I1 默认值表）。automation 在 P2-6 切换为 agent（单行可回退）。 */
export const DEFAULT_CONFIRM_ANSWERER: Record<ExecutionLane, ConfirmAnswererPolicy> = {
  desktop: { kind: 'user' },
  wechat: { kind: 'user' },
  feishu: { kind: 'user' },
  automation: { kind: 'deny' }
}

const LANES: readonly ExecutionLane[] = ['desktop', 'wechat', 'feishu', 'automation']

function warn(fallback: ConfirmAnswererPolicy, detail: string): ConfirmAnswererPolicy {
  logAgentEvent('warn', 'confirm.answerer.config_fallback', { detail, fallback: fallback.kind })
  return fallback
}

/**
 * P2 回答者解析（I1）：lane → 回答者配置。
 * - 配置缺失 → 默认值表（desktop/wechat/feishu=user；automation 由 P2-6 开关决定 deny/agent）；
 * - 配置损坏 / kind 非法 → deny + 告警（I4：绝不回退 user——无人场景回退问用户 = 挂死 5 分钟）；
 * - automation 强制无人化：配置为 user 一律打回默认值（无人值守 lane 无豁免来源）。
 */
export function resolveLaneAnswererPolicy(db: AppDatabase | null | undefined, lane: ExecutionLane): ConfirmAnswererPolicy {
  const laneDefault = DEFAULT_CONFIRM_ANSWERER[lane]
  const raw = db ? getConfigValue(db, CONFIRM_ANSWERERS_CONFIG_KEY) : null
  if (!raw) return laneDefault
  let map: ConfirmAnswererMap
  try {
    map = JSON.parse(raw) as ConfirmAnswererMap
  } catch {
    return warn({ kind: 'deny' }, `回答者配置 JSON 损坏（lane=${lane}），按 deny 兜底`)
  }
  const entry = map?.[lane]
  if (!entry) return laneDefault
  if (entry.kind !== 'user' && entry.kind !== 'agent' && entry.kind !== 'deny') {
    return warn(
      { kind: 'deny' },
      `回答者配置 kind 非法（lane=${lane}，kind=${String((entry as { kind?: unknown }).kind)}），按 deny 兜底`
    )
  }
  // automation 强制无人化：不允许配置为 user（无人值守 lane 无豁免来源，挂死 5 分钟不可接受）
  if (lane === 'automation' && entry.kind === 'user') {
    return warn(laneDefault, 'automation lane 不允许配置 user 回答者，已打回默认值')
  }
  if (entry.timeoutMs != null && (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0)) {
    return warn({ kind: entry.kind }, `回答者配置 timeoutMs 非法（lane=${lane}），忽略该字段`)
  }
  return entry
}

/** 当前生效回答者种类（供套餐约束 / 审计装配读取）。 */
export function resolveLaneAnswererKind(db: AppDatabase | null | undefined, lane: ExecutionLane): ConfirmAnswererKind {
  return resolveLaneAnswererPolicy(db, lane).kind
}
