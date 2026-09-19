import type { AgentReasoningEffort } from '../src/shared/agent/invocation'
import type { ToolLoopOutputConfig, ToolLoopThinkingConfig } from './claudeToolLoopStreamParams'

/**
 * 档位 → wire 参数映射（需求 §7.3）：
 * off → thinking disabled、不发送 output_config；
 * low / medium / high → adaptive + output_config.effort 同发（官方 adaptive 迁移写法，两字段正交）。
 * 映射集中在此，不散落在业务代码里。
 */
export function buildThinkingWireParams(effort: AgentReasoningEffort): {
  thinking: ToolLoopThinkingConfig
  outputConfig?: ToolLoopOutputConfig
} {
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  return { thinking: { type: 'adaptive' }, outputConfig: { effort } }
}

/**
 * 「上游不认 output_config」类错误判定（§7.4）：400 + 错误消息点名 output_config。
 * 只处理强度字段被拒，不得掩盖鉴权失败 / 模型不可用 / 预算类真实错误（fail-fast 语义保留）。
 */
export function isOutputConfigRejectedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = (err as { status?: unknown }).status
  const message = err instanceof Error ? err.message : String(err)
  return status === 400 && typeof message === 'string' && message.includes('output_config')
}

/**
 * 上游拒绝 output_config 后的进程内记忆（OQ-6）：
 * key = llmServiceId + model（非仅 service，避免同服务下其他模型被连坐禁用）；进程重启即清空。
 */
const unsupportedMemo = new Map<string, true>()

export function effortMemoKey(llmServiceId: string | undefined, model: string): string {
  return `${llmServiceId ?? ''}|${model}`
}

export function isEffortUnsupportedByUpstream(llmServiceId: string | undefined, model: string): boolean {
  return unsupportedMemo.has(effortMemoKey(llmServiceId, model))
}

export function memoizeEffortUnsupported(llmServiceId: string | undefined, model: string): void {
  unsupportedMemo.set(effortMemoKey(llmServiceId, model), true)
}

const memoizedSkipAudited = new Set<string>()

/** 首次因记忆跳过 output_config 时返回 true（供调用方落一次 llm.effort.unsupported_memoized 审计），之后同 key 返回 false。 */
export function consumeEffortMemoizedAudit(llmServiceId: string | undefined, model: string): boolean {
  const key = effortMemoKey(llmServiceId, model)
  if (!unsupportedMemo.has(key) || memoizedSkipAudited.has(key)) return false
  memoizedSkipAudited.add(key)
  return true
}

/** 仅测试使用：等价「进程重启清空」。 */
export function resetEffortMemoForTests(): void {
  unsupportedMemo.clear()
  memoizedSkipAudited.clear()
}
