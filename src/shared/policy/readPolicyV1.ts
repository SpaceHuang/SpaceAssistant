import type { ContentFacts, Decision, ExecutionContext, PathZone } from '../confirmation/types'
type ReadTargetKind = 'file' | 'directory' | 'missing' | 'symlink' | 'special' | 'unknown'
/** 只校验 V1 目标契约；授权动作一律交给统一 policy engine 和生效规则集。 */
export function validateDesktopReadV1(input: { facts: ContentFacts; context: ExecutionContext; zone?: PathZone; targetKind?: ReadTargetKind; hasExplicitPath: boolean; hasUnsupportedPattern?: boolean }): Decision | undefined {
  const { facts, context } = input
  if (context.lane !== 'desktop' || !['read_file', 'grep'].includes(facts.toolName)) return { type: 'deny', ruleId: 'read-v1-scope-deny', reason: '读取工具不在 V1 desktop 范围内' }
  if (!input.hasExplicitPath || !input.zone || !input.targetKind) return { type: 'deny', ruleId: 'read-v1-facts-missing', reason: '读取目标事实缺失' }
  if (input.hasUnsupportedPattern || !['file', 'symlink', 'missing'].includes(input.targetKind)) return { type: 'deny', ruleId: 'read-v1-target-unsupported', reason: 'V1 仅支持单个显式文件目标' }
  return undefined
}
