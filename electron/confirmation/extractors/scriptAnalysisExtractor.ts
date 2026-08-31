import {
  analyzeScriptContent,
  isScriptCertifiedRemoteSafe,
  parsePythonModule,
  collectPatternHits
} from '../../shell/scriptContentSecurity'
import type { ContentFacts, EnvFacts, FactSignal, ConfirmSummary } from '../../../src/shared/confirmation/types'

/**
 * 脚本内容分析提取器（run_script / run_script 类）。
 *
 * 原则：只产出事实，不做放行/拒绝判定。把现状 analyzeScriptContent 的
 * `verdict: allow/ask/deny` 映射为「模式级事实」`signal: clean/suspicious/dangerous`；
 * 网络命中单独产 `script-network` 信号（与通用 `network-egress` 区分，避免与 browser /
 * run_shell 的网络事实混用）；远程认证态未通过时产 `script-uncertified` 信号。
 * 提取器本身不感知 lane——链路的差异由策略层规则按 lane 消费。
 *
 * 注意：为保持外部行为完全等价，这里仍复用现有的黑名单命中分析；但返回值类型不再含
 * verdict 判定字段，判定完全交给策略层。
 */

const NETWORK_PATTERNS = new Set(['A6', 'B10'])

function detectNetworkHits(code: string): string[] {
  try {
    const ast = parsePythonModule(code)
    const hits = collectPatternHits(ast, {})
    return hits.filter((h) => NETWORK_PATTERNS.has(h.pattern)).map((h) => h.pattern)
  } catch {
    return []
  }
}

export function extractScriptSignals(
  code: string,
  _env: EnvFacts
): { signals: FactSignal[]; summary: ConfirmSummary } {
  const signals: FactSignal[] = []
  const analysis = analyzeScriptContent(code, {})
  const signal = analysis.verdict === 'allow' ? 'clean' : analysis.verdict === 'deny' ? 'dangerous' : 'suspicious'
  signals.push({ kind: 'script-analysis', signal, patterns: analysis.patterns })

  const networkHits = detectNetworkHits(code)
  if (networkHits.length > 0) {
    signals.push({ kind: 'script-network', patterns: networkHits })
  }

  // 远程认证态：未通过 isScriptCertifiedRemoteSafe 认证时产 script-uncertified 信号
  try {
    const ast = parsePythonModule(code)
    if (!isScriptCertifiedRemoteSafe(ast)) {
      signals.push({ kind: 'script-uncertified' })
    }
  } catch {
    signals.push({ kind: 'extraction-failed', reason: 'parse_error' })
  }

  const summaryText =
    signal === 'clean'
      ? '脚本静态分析未发现危险模式'
      : signal === 'dangerous'
        ? '脚本含危险模式，已拒绝'
        : '脚本含需确认的危险模式'
  return {
    signals,
    summary: {
      text: summaryText,
      sections: analysis.patterns.length > 0 ? [{ label: '命中模式', value: analysis.patterns.join(', ') }] : []
    }
  }
}

/** 便捷入口：为 run_script 组装 ContentFacts。 */
export function buildScriptFacts(
  toolName: string,
  code: string,
  env: EnvFacts
): ContentFacts {
  const { signals, summary } = extractScriptSignals(code, env)
  return {
    toolName,
    actionClass: 'execute',
    baseRiskLevel: 'high',
    signals,
    summary
  }
}
