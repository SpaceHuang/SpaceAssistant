import type { ConfirmAnswererKind, ContentFacts, ExecutionLane, FactSignal } from '../confirmation/types'

export type MemoryEligibility = 'none' | 'session' | 'persistent'

export interface MemoryEligibilityResult {
  eligibility: MemoryEligibility
  reasons: string[]
}

/**
 * 统一确认记忆资格：缓存读取、确认 UI 档位和缓存写入必须共享这层结果。
 * 该函数只基于事实和链路，不执行任何缓存读写，也不决定本次执行是否允许。
 * 回答者维度（I3）：记忆只源于人类——answererKind 非 'user' 一律无资格。
 */
export function deriveMemoryEligibility(
  facts: ContentFacts,
  lane: ExecutionLane,
  answererKind: ConfirmAnswererKind = 'user'
): MemoryEligibilityResult {
  const reasons: string[] = []
  if (answererKind !== 'user') {
    reasons.push('non-human-answerer')
    return { eligibility: 'none', reasons }
  }
  if (facts.actionClass === 'outbound' && (lane === 'wechat' || lane === 'feishu')) {
    reasons.push('outbound-never-remembered')
    return { eligibility: 'none', reasons }
  }
  if (facts.signals.some((signal) => signal.kind === 'script-network' || signal.kind === 'script-uncertified')) {
    reasons.push('script-network-or-uncertified')
    return { eligibility: 'none', reasons }
  }
  if (facts.signals.some((signal) => signal.kind === 'path-target' &&
      (signal.zone === 'sensitive-file' || signal.zone === 'outside-workdir' || signal.zone === 'system-dir'))) {
    reasons.push('path-risk')
    return { eligibility: 'none', reasons }
  }
  if (facts.signals.some((signal) => signal.kind === 'extraction-failed')) {
    reasons.push('analysis-incomplete')
    return { eligibility: 'none', reasons }
  }
  // B1（评审 2026-09-28）：树解析失败（unsupported）的命令事实链不完整——确认一次后
  // 不得写持久 allow 缓存，否则「partial 永不自动放行」被缓存路径整体绕过。
  if (facts.signals.some((signal) => signal.kind === 'shell-unsupported-structure')) {
    reasons.push('shell-analysis-incomplete')
    return { eligibility: 'none', reasons }
  }
  if (facts.signals.some((signal) => signal.kind === 'command-sequence' && signal.persistable !== true)) {
    reasons.push('non-persistable-command')
    return { eligibility: 'none', reasons }
  }
  const incompleteScript = facts.signals.find((signal): signal is Extract<FactSignal, { kind: 'script-path-extraction' }> =>
    signal.kind === 'script-path-extraction' && signal.completeness === 'unknown'
  )
  const validContentDigest = Boolean(incompleteScript && incompleteScript.contentDigest && /^[a-f0-9]{64}$/.test(incompleteScript.contentDigest))
  if (incompleteScript && (incompleteScript.unknownReason !== 'unmodeled-call' || incompleteScript.dynamicAccess || !validContentDigest)) {
    reasons.push('script-analysis-incomplete')
    return { eligibility: 'none', reasons }
  }
  if (facts.signals.some((signal) => signal.kind === 'script-analysis' && signal.signal !== 'clean') ||
      (incompleteScript && !facts.signals.some((signal) => signal.kind === 'script-analysis' && signal.signal === 'clean'))) {
    reasons.push('script-not-clean')
    return { eligibility: 'none', reasons }
  }
  if (incompleteScript) {
    reasons.push('script-content-session-only')
    return { eligibility: 'session', reasons }
  }
  if (lane === 'wechat' || lane === 'feishu') {
    reasons.push('remote-session-only')
    return { eligibility: 'session', reasons }
  }
  return { eligibility: 'persistent', reasons }
}
