import type { ContentFacts, Decision, ExecutionContext, PathZone } from '../confirmation/types'
type ReadTargetKind = 'file' | 'directory' | 'missing' | 'symlink' | 'special' | 'unknown'
/** 只校验 V1 目标契约；授权动作一律交给统一 policy engine 和生效规则集。 */
export function validateDesktopReadV1(input: { facts: ContentFacts; context: ExecutionContext; zone?: PathZone; targetKind?: ReadTargetKind; hasExplicitPath: boolean; hasUnsupportedPattern?: boolean }): Decision | undefined {
  const { facts, context } = input
  if (context.lane !== 'desktop' || !['read_file', 'grep'].includes(facts.toolName)) return { type: 'deny', ruleId: 'read-v1-scope-deny', reason: '读取工具不在 V1 desktop 范围内' }
  if (!input.hasExplicitPath || !input.zone || !input.targetKind) return { type: 'deny', ruleId: 'read-v1-facts-missing', reason: '读取目标事实缺失' }
  if (input.hasUnsupportedPattern) return { type: 'deny', ruleId: 'read-path-pattern-unsupported', reason: '读取目标不支持通配路径或多路径输入' }
  const allowed: ReadTargetKind[] = facts.toolName === 'grep'
    ? ['file', 'directory', 'symlink', 'missing']
    : ['file', 'symlink', 'missing']
  if (!allowed.includes(input.targetKind)) return { type: 'deny', ruleId: 'read-v1-target-unsupported', reason: '读取目标类型不支持该工具（read_file 仅文件；grep 支持文件与目录）' }
  return undefined
}
