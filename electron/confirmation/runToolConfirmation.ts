import { decide } from '../../src/shared/policy/policyEngine'
import { runExtractors } from './extractors/runExtractors'
import type {
  ConfirmOutcome,
  ConfirmationChannel,
  Decision,
  EnvFacts,
  ExecutionContext,
  PolicyEngineDeps,
  PolicyRule,
  ToolActionDescriptor
} from '../../src/shared/confirmation/types'

export interface ToolConfirmationResult {
  decision: Decision
  outcome?: ConfirmOutcome
  approved: boolean
}

/**
 * §5.5 主循环直线流程（测试化编排）：组装上下文 → 事实提取 → 策略判定 → 通道确认。
 * 记账（预算/grant reserve）与"写缓存/审计发射"仍由调用方在拿到结果后执行（策略层保持纯函数）。
 */
export async function runToolConfirmation(args: {
  descriptor: ToolActionDescriptor
  toolInput: Record<string, unknown>
  env: EnvFacts
  context: ExecutionContext
  rules: PolicyRule[]
  deps: PolicyEngineDeps
  channel: ConfirmationChannel
}): Promise<ToolConfirmationResult> {
  const facts = runExtractors(args.descriptor, args.toolInput, args.env)
  const decision = decide(facts, args.context, args.rules, args.deps)
  if (decision.type === 'auto-allow') return { decision, approved: true }
  if (decision.type === 'deny') return { decision, approved: false }
  const outcome = await args.channel.request({
    facts: decision.facts,
    riskLevel: decision.riskLevel,
    memoryTiers: decision.memoryTiers,
    timeoutMs: decision.timeoutMs
  })
  return { decision, outcome, approved: outcome.kind === 'approved' }
}
