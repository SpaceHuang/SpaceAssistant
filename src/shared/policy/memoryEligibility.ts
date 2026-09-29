import type { ConfirmAnswererKind, ContentFacts, ExecutionLane } from '../confirmation/types'

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
  if (facts.signals.some((signal) => signal.kind === 'script-network' || signal.kind === 'script-uncertified')) {
    reasons.push('script-network-or-uncertified')
    return { eligibility: 'none', reasons }
  }
  // P1/P2(方案 §5):路径提取 unknown 的脚本——dynamic-execution 走 locked 逐次确认,不开放
  // 任何记忆;unmodeled-call 仅开放会话级(P2-2 脚本内容指纹,exact-content 键;路径键在
  // deriveCacheKeys 中整体抑制,防止不同脚本经重叠路径命中缓存)。
  if (facts.signals.some((signal) => signal.kind === 'script-path-extraction' && signal.completeness === 'unknown')) {
    const dynamic = facts.signals.some(
      (signal) => signal.kind === 'script-path-extraction' && signal.unknownReason === 'dynamic-execution'
    )
    if (dynamic) {
      reasons.push('script-path-unknown')
      return { eligibility: 'none', reasons }
    }
    reasons.push('script-path-unknown-session-only')
    return { eligibility: 'session', reasons }
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
  if (lane === 'wechat' || lane === 'feishu') {
    reasons.push('remote-session-only')
    return { eligibility: 'session', reasons }
  }
  return { eligibility: 'persistent', reasons }
}
