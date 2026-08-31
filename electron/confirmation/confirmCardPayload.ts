import type {
  Decision,
  MemoryTier,
  RiskLevel
} from '../../src/shared/confirmation/types'

export interface ConfirmCardPayload {
  toolName: string
  riskLevel: RiskLevel
  factsSummary: string
  signals: string[]
  memoryTiers: Array<{ label: string; tier: number }>
  timeoutMs: number | null
}

/**
 * 确认卡片数据契约（P3）：把 Decision(require-confirm) 映射为渲染端确认卡片所需的
 * 内容摘要、风险等级、记忆范围档位选项（编号对应 memoryTiers 顺序，供 IM `记N` 对齐）。
 */
export function confirmCardPayload(decision: Extract<Decision, { type: 'require-confirm' }>): ConfirmCardPayload {
  return {
    toolName: decision.facts.toolName,
    riskLevel: decision.riskLevel,
    factsSummary: decision.facts.summary.text,
    signals: decision.facts.signals.map((s) => s.kind),
    memoryTiers: decision.memoryTiers.map((t: MemoryTier, i) => ({ label: t.label, tier: i + 1 })),
    timeoutMs: decision.timeoutMs
  }
}
