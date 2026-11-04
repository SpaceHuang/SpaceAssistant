import {
  analyzeScriptContent,
  isScriptCertifiedRemoteSafe,
  parsePythonModule
} from '../../shell/scriptContentSecurity'
import type { IrModule } from '../../shell/scriptIr/types'
import type { ContentFacts, EnvFacts, FactSignal, ConfirmSummary } from '../../../src/shared/confirmation/types'
import { CONFIRMATION_LABELS } from '../../../src/shared/confirmation/labels'

function staticNetworkReviewCandidate(ir: IrModule): { host: string; method: 'GET' | 'HEAD'; url: string } | undefined {
  if (ir.body.length !== 2) return undefined
  const [imp, expression] = ir.body
  if (imp?.kind !== 'import' || imp.names.length !== 1 || imp.names[0]?.module !== 'requests' || imp.names[0].alias) return undefined
  if (expression?.kind !== 'expr' || expression.value.kind !== 'call') return undefined
  const call = expression.value
  if (call.callee.kind !== 'attr' || call.callee.base.kind !== 'name' || call.callee.base.id !== 'requests') return undefined
  if (call.callee.attr !== 'get' && call.callee.attr !== 'head') return undefined
  if (call.args.length !== 1 || call.args[0]?.kind !== 'string' || call.kwargs.length !== 2) return undefined
  const timeout = call.kwargs.find((kw) => kw.name === 'timeout')?.value
  const redirects = call.kwargs.find((kw) => kw.name === 'allow_redirects')?.value
  if (call.kwargs.some((kw) => kw.name !== 'timeout' && kw.name !== 'allow_redirects')) return undefined
  if (timeout?.kind !== 'number' || !Number.isFinite(Number(timeout.value)) || Number(timeout.value) <= 0 || Number(timeout.value) > 30) return undefined
  if (redirects?.kind !== 'bool' || redirects.value !== false) return undefined
  const value = call.args[0].value
  let parsed: URL
  try { parsed = new URL(value) } catch { return undefined }
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return undefined
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return undefined
  return { host, method: call.callee.attr === 'get' ? 'GET' : 'HEAD', url: parsed.toString() }
}

export function hasStaticNetworkReviewCandidate(code: string): boolean {
  try { return Boolean(staticNetworkReviewCandidate(parsePythonModule(code))) } catch { return false }
}

/**
 * 脚本内容分析提取器（run_script / run_script 类）。
 *
 * 原则：只产出 findings 与 coverage，不做放行/拒绝判定；网络类别也只由 `network-api` finding 表达。
 * 远程认证态未通过时仍由独立所有者产 `script-uncertified` 信号。
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

  // 单次解析（M8 / P1-T3）：IR 同时供 findings 提取与独立远程认证态检查。
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
    ? analyzeScriptContent(code, ir)
    : { reason: 'parse_error', findings: [], coverage: 'failed' as const, totalCount: 0 }
  signals.push({
    kind: 'script-analysis',
    findings: analysis.findings,
    coverage: analysis.coverage,
    totalCount: analysis.totalCount
  })

  if (parseFailed || !ir) {
    signals.push({ kind: 'extraction-failed', reason: 'parse_error' })
  } else {
    if (analysis.coverage === 'failed') {
      signals.push({ kind: 'extraction-failed', reason: analysis.reason ?? 'script-analysis-location-unavailable' })
    }
    if (analysis.findings.some((finding) => finding.class === 'network-api')) {
      const candidate = staticNetworkReviewCandidate(ir)
      if (candidate) signals.push({ kind: 'im-script-network-review-candidate', status: 'complete', ...candidate })
    }
    // 远程认证态：未通过 isScriptCertifiedRemoteSafe 认证时产 script-uncertified 信号
    if (!isScriptCertifiedRemoteSafe(ir)) {
      signals.push({ kind: 'script-uncertified' })
    }
  }

  return {
    signals,
    summary: { text: CONFIRMATION_LABELS.summaryScriptAnalysis }
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
