import {
  analyzeScriptContent,
  isScriptCertifiedRemoteSafe,
  parsePythonModule,
  collectPatternHits,
  NETWORK_PATTERN_IDS
} from '../../shell/scriptContentSecurity'
import type { IrModule } from '../../shell/scriptIr/types'
import type { ContentFacts, EnvFacts, FactSignal, ConfirmSummary } from '../../../src/shared/confirmation/types'
import { CONFIRMATION_LABELS } from '../../../src/shared/confirmation/labels'

/**
 * 脚本内容分析提取器（run_script / run_script 类）。
 *
 * 原则：只产出事实，不做放行/拒绝判定。把现状 analyzeScriptContent 的
 * `verdict: allow/ask/deny` 映射为「模式级事实」`signal: clean/suspicious/dangerous`；
 * 网络命中单独产 `script-network` 信号（与通用 `network-egress` 区分，避免与 browser /
 * run_shell 的网络事实混用）；远程认证态未通过时产 `script-uncertified` 信号。
 * 提取器本身不感知 lane——链路的差异由策略层规则按 lane 消费。
 *
 * P1-T3：单次解析——`preParsedIr` 传入时不再自解析（toolCallGate 门控路径恰好 1 次 parse）；
 * 第二调用点 runExtractors（descriptor 驱动）不传预解析，自解析能力保留。
 * 解析失败（语法错误 / 服务未就绪 / IrCoverageError）→ `extraction-failed` 信号落人工（fail-closed）。
 */

export function extractScriptSignals(
  code: string,
  _env: EnvFacts,
  preParsedIr?: IrModule
): { signals: FactSignal[]; summary: ConfirmSummary } {
  const signals: FactSignal[] = []

  // 单次解析（M8 / P1-T3）：IR 同时供 verdict 判定、网络命中识别与远程认证态
  let ir: IrModule | null = preParsedIr ?? null
  let parseFailed = false
  if (!ir) {
    try {
      ir = parsePythonModule(code)
    } catch {
      parseFailed = true
    }
  }

  const analysis = ir
    ? analyzeScriptContent(code, {}, ir)
    : { verdict: 'ask' as const, patterns: ['A-fail'], reason: 'parse_error' }
  const signal = analysis.verdict === 'allow' ? 'clean' : analysis.verdict === 'deny' ? 'dangerous' : 'suspicious'
  signals.push({ kind: 'script-analysis', signal, patterns: analysis.patterns })

  if (parseFailed || !ir) {
    signals.push({ kind: 'extraction-failed', reason: 'parse_error' })
  } else {
    // P2-1 评审修复：二次 hits 与第一次同输入，防御性兜底（若抛错按 extraction-failed 落人工，保持 fail-closed）
    let networkPatterns: string[] = []
    let hitsFailed = false
    try {
      networkPatterns = collectPatternHits(ir, {})
        .filter((h) => NETWORK_PATTERN_IDS.has(h.pattern))
        .map((h) => h.pattern)
    } catch {
      hitsFailed = true
    }
    if (hitsFailed) {
      signals.push({ kind: 'extraction-failed', reason: 'pattern-hit-error' })
      return {
        signals,
        summary: {
          text: CONFIRMATION_LABELS.summarySuspiciousScript,
          sections: analysis.patterns.length > 0 ? [{ label: '命中模式', value: analysis.patterns.join(', ') }] : []
        }
      }
    }
    if (networkPatterns.length > 0) {
      signals.push({ kind: 'script-network', patterns: networkPatterns })
    }
    // 远程认证态：未通过 isScriptCertifiedRemoteSafe 认证时产 script-uncertified 信号
    if (!isScriptCertifiedRemoteSafe(ir)) {
      signals.push({ kind: 'script-uncertified' })
    }
  }

  const summaryText =
    signal === 'clean'
      ? CONFIRMATION_LABELS.summaryCleanScript
      : signal === 'dangerous'
        ? CONFIRMATION_LABELS.summaryDangerousScript
        : CONFIRMATION_LABELS.summarySuspiciousScript
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
