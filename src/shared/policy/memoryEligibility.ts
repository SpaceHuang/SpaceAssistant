import type { ContentFacts, ExecutionLane } from '../confirmation/types'

export type MemoryEligibility = 'none' | 'session' | 'persistent'

export interface MemoryEligibilityResult {
  eligibility: MemoryEligibility
  reasons: string[]
}

/**
 * 统一确认记忆资格：缓存读取、确认 UI 档位和缓存写入必须共享这层结果。
 * 该函数只基于事实和链路，不执行任何缓存读写，也不决定本次执行是否允许。
 */
export function deriveMemoryEligibility(
  facts: ContentFacts,
  lane: ExecutionLane
): MemoryEligibilityResult {
  const reasons: string[] = []
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
  if (facts.signals.some((signal) => signal.kind === 'command-sequence' && signal.persistable !== true)) {
    reasons.push('non-persistable-command')
    return { eligibility: 'none', reasons }
  }
  if (lane === 'wechat' || lane === 'feishu') {
    reasons.push('remote-session-only')
    return { eligibility: 'session', reasons }
  }
  return { eligibility: 'persistent', reasons }
}
