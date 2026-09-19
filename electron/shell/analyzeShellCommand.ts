import { parseShellSegments } from './shellCommandParser'
import { analyzeSegmentPaths, verifyPathsInWorkDir } from './shellPathAnalysis'
import { evaluateShellPermission } from './shellPermissions'
import {
  buildSecurityContext,
  getShellSecurityDenyMessage,
  getShellSecurityWarningMessage,
  runShellSecurityValidators
} from './shellSecurity'
import type { ShellAnalysisResult, ShellPathVerdict, ShellPathLiteral } from './shellTypes'
import type { ShellConfig } from '../../src/shared/domainTypes'
import { shouldSkipShellConfirmForTrust } from './shellCommandTrust'
import { analyzeShellFacts } from './shellAnalyzer'
import { profileForPlatform } from './shellProfiles'
import { extractBashCommandFacts, type BashCommandFacts } from './bashCommandFacts'
import { extractPowershellCommandFacts, type PsCommandFacts } from './powershellCommandFacts'
import { matchPsDangerousPatterns } from './psSecurityRules'

export async function analyzeShellCommand(
  workDir: string,
  command: string,
  platform: NodeJS.Platform,
  shellConfig?: ShellConfig | null,
  userDataDir?: string
): Promise<ShellAnalysisResult> {
  const dialect = profileForPlatform(platform).dialect
  // P2-T2（发现 B）：单次 analyzeShellCommand（posix-bash）内恰好 1 次解析——
  // 树事实同时供主裁决链增强与 facts 附加复用。
  let treeFacts: BashCommandFacts | PsCommandFacts | undefined
  if (dialect === 'posix-bash') {
    treeFacts = extractBashCommandFacts(command)
  } else if (dialect === 'windows-powershell') {
    treeFacts = extractPowershellCommandFacts(command)
  }
  const bashFacts = treeFacts && 'connectorFlow' in treeFacts ? (treeFacts as BashCommandFacts) : undefined
  const psFacts = treeFacts && !('connectorFlow' in treeFacts) ? (treeFacts as PsCommandFacts) : undefined
  const result = await analyzeShellCommandWithPolicy(workDir, command, platform, shellConfig, userDataDir, bashFacts, psFacts)
  return { ...result, facts: analyzeShellFacts(command, dialect, treeFacts) }
}

async function analyzeShellCommandWithPolicy(
  workDir: string,
  command: string,
  platform: NodeJS.Platform,
  shellConfig?: ShellConfig | null,
  userDataDir?: string,
  bashFacts?: BashCommandFacts,
  psFacts?: PsCommandFacts
): Promise<ShellAnalysisResult> {
  // P3-T5：PS 树事实解析失败 → 与 bash 同语义的失败兜底（fail-closed）
  if (psFacts && !psFacts.ok) {
    const msg = '命令语法解析失败，无法进行安全分析'
    return {
      verdict: 'deny',
      denyReason: msg,
      segments: [],
      pathVerdict: emptyPathVerdict(msg),
      shellSecurityHints: {
        requiresRiskAck: true,
        outsideWorkDirRisk: true,
        warnings: [msg]
      }
    }
  }
  // P2-T2：树事实解析失败 → 与既有分段失败分支同形的失败结果（fail-closed，只增不减的更严侧）
  if (bashFacts && !bashFacts.ok) {
    const msg = '命令语法解析失败，无法进行安全分析'
    return {
      verdict: 'deny',
      denyReason: msg,
      segments: [],
      pathVerdict: emptyPathVerdict(msg),
      shellSecurityHints: {
        requiresRiskAck: true,
        outsideWorkDirRisk: true,
        warnings: [msg]
      }
    }
  }

  let segments: string[]
  try {
    segments = parseShellSegments(command)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      verdict: 'deny',
      denyReason: msg,
      segments: [],
      pathVerdict: emptyPathVerdict(msg),
      shellSecurityHints: {
        requiresRiskAck: true,
        outsideWorkDirRisk: true,
        warnings: [msg]
      }
    }
  }

  const { literals, pathVerdict } = await analyzeSegmentPaths(
    workDir,
    segments,
    userDataDir,
    shellConfig?.customSensitivePrefixes
  )

  // P2-T2：路径增强（只增不减）——由树事实（redirects[].target / args）产出补充
  // ShellPathLiteral[]，经既有 verifyPathsInWorkDir 判定后并入 pathVerdict；
  // 禁止把结构化事实拼回字符串喂 extractPathLiterals（树增强路径内零调用）。
  let finalPathVerdict = pathVerdict
  if (bashFacts?.ok) {
    const extraLiterals = collectTreePathLiterals(bashFacts)
    if (extraLiterals.length > 0) {
      const extraVerdict = await verifyPathsInWorkDir(workDir, extraLiterals, userDataDir, shellConfig?.customSensitivePrefixes)
      finalPathVerdict = mergePathVerdicts(pathVerdict, extraVerdict)
    }
  }

  const perm = evaluateShellPermission(command, segments, shellConfig?.rules)
  if (perm.decision === 'deny') {
    return {
      verdict: 'deny',
      denyReason: perm.reason ?? '命令被规则拒绝',
      segments,
      pathVerdict: finalPathVerdict,
      permissionDecision: 'deny',
      shellSecurityHints: buildHints(finalPathVerdict)
    }
  }

  const ctx = buildSecurityContext(command, platform, workDir, segments, finalPathVerdict, literals)
  const sec = runShellSecurityValidators(ctx)
  if (sec.verdict === 'deny') {
    return {
      verdict: 'deny',
      denyReason: getShellSecurityDenyMessage(sec.validatorId ?? ''),
      validatorId: sec.validatorId,
      denyType: sec.denyType ?? 'strong',
      segments,
      pathVerdict: finalPathVerdict,
      permissionDecision: perm.decision,
      shellSecurityHints: buildHints(finalPathVerdict, sec.validatorId, sec.denyType)
    }
  }

  if (sec.verdict === 'ask' && sec.validatorId && sec.denyType === 'weak') {
    const securityWarning = getShellSecurityWarningMessage(sec.validatorId)
    const hints = buildHints(finalPathVerdict, sec.validatorId, 'weak', securityWarning)
    return {
      verdict: 'ask',
      validatorId: sec.validatorId,
      denyType: 'weak',
      segments,
      pathVerdict: finalPathVerdict,
      permissionDecision: perm.decision,
      shellSecurityHints: hints
    }
  }

  // P3-T5：PS 路径增强（树事实 redirects/args → 补充字面量 → 只增不减并入）
  if (psFacts?.ok) {
    const extraLiterals = collectPsTreePathLiterals(psFacts)
    if (extraLiterals.length > 0) {
      const extraVerdict = await verifyPathsInWorkDir(workDir, extraLiterals, userDataDir, shellConfig?.customSensitivePrefixes)
      finalPathVerdict = mergePathVerdicts(finalPathVerdict, extraVerdict)
    }
  }

  // P2-T4 / P3-T3：结构性危险模式（树事实驱动，只向更严合并）
  if (psFacts?.ok) {
    const pattern = matchPsDangerousPatterns(psFacts, userDataDir, shellConfig?.customSensitivePrefixes)
    if (pattern) {
      return {
        verdict: pattern.verdict === 'deny' ? 'deny' : 'ask',
        denyReason: pattern.verdict === 'deny' ? pattern.reason : undefined,
        validatorId: pattern.id,
        denyType: pattern.verdict === 'deny' ? 'strong' : 'weak',
        segments,
        pathVerdict: finalPathVerdict,
        permissionDecision: perm.decision,
        shellSecurityHints: buildHints(finalPathVerdict, pattern.id, pattern.verdict === 'deny' ? 'strong' : 'weak', pattern.reason)
      }
    }
  }
  if (bashFacts?.ok) {
    const pattern = matchBashDangerousPatterns(bashFacts, userDataDir, shellConfig?.customSensitivePrefixes)
    if (pattern) {
      return {
        verdict: pattern.verdict === 'deny' ? 'deny' : 'ask',
        denyReason: pattern.verdict === 'deny' ? pattern.reason : undefined,
        validatorId: pattern.id,
        denyType: pattern.verdict === 'deny' ? 'strong' : 'weak',
        segments,
        pathVerdict: finalPathVerdict,
        permissionDecision: perm.decision,
        shellSecurityHints: buildHints(finalPathVerdict, pattern.id, pattern.verdict === 'deny' ? 'strong' : 'weak', pattern.reason)
      }
    }
  }

  const hints = buildHints(finalPathVerdict)
  return {
    verdict: 'ask',
    segments,
    pathVerdict: finalPathVerdict,
    permissionDecision: perm.decision,
    shellSecurityHints: hints
  }
}

function collectPsTreePathLiterals(facts: PsCommandFacts): ShellPathLiteral[] {
  const out: ShellPathLiteral[] = []
  const push = (raw: string) => {
    if (!raw || raw.startsWith('-') || raw.startsWith('$')) return
    if (/[\/]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('~') || raw.startsWith('.')) {
      out.push({ raw, segmentIndex: 0, kind: 'arg' })
    }
  }
  for (const cmd of facts.commands) {
    for (const arg of cmd.args) push(arg)
    for (const r of cmd.redirects) push(r.target)
  }
  return out
}

/** 树事实中的路径形态字面量（redirects 目标 + 路径形态 args）。 */
function collectTreePathLiterals(facts: BashCommandFacts): ShellPathLiteral[] {
  const out: ShellPathLiteral[] = []
  const push = (raw: string) => {
    if (!raw || raw.startsWith('-') || raw.startsWith('$') || raw.startsWith('`')) return
    if (/[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('~') || raw.startsWith('.')) {
      out.push({ raw, segmentIndex: 0, kind: 'arg' })
    }
  }
  for (const cmd of facts.commands) {
    for (const arg of cmd.args) push(arg)
    for (const r of cmd.redirects) push(r.target)
  }
  return out
}

/** verdict 合并只增不减：violations/warnings 并集、风险布尔取或。 */
function mergePathVerdicts(base: ShellPathVerdict, extra: ShellPathVerdict): ShellPathVerdict {
  const violations = [...base.violations]
  for (const v of extra.violations) {
    if (!violations.some((b) => b.code === v.code && b.path === v.path)) violations.push(v)
  }
  const warnings = [...base.warnings]
  for (const w of extra.warnings) {
    if (!warnings.includes(w)) warnings.push(w)
  }
  return {
    decision: base.decision,
    violations,
    warnings,
    outsideWorkDirRisk: base.outsideWorkDirRisk || extra.outsideWorkDirRisk,
    requiresRiskAck: base.requiresRiskAck || extra.requiresRiskAck
  }
}

function buildHints(
  pathVerdict: ShellPathVerdict,
  validatorId?: string,
  denyType?: 'strong' | 'weak',
  securityWarning?: string
) {
  const codes = pathVerdict.violations.map((v) => v.code)
  const violationCodes = validatorId
    ? [...(codes.length ? codes : []), validatorId]
    : codes.length
      ? codes
      : undefined
  return {
    requiresRiskAck: pathVerdict.requiresRiskAck || pathVerdict.outsideWorkDirRisk || denyType === 'weak',
    outsideWorkDirRisk: pathVerdict.outsideWorkDirRisk,
    warnings: pathVerdict.warnings,
    scannedPaths: pathVerdict.violations.map((v) => v.path).filter(Boolean) as string[],
    violationCodes,
    validatorId,
    denyType,
    securityWarning
  }
}

function emptyPathVerdict(warning?: string): ShellPathVerdict {
  return {
    decision: 'ask' as const,
    violations: warning
      ? [{ code: 'PARSE_ERROR', message: warning, severity: 'warning' as const }]
      : [],
    warnings: warning ? [warning] : [],
    outsideWorkDirRisk: true,
    requiresRiskAck: true
  }
}

import { matchBashDangerousPatterns } from './bashSecurityRules'

/** 是否可跳过用户确认（信任列表 / 自动执行 / allow 规则） */
export function canSkipShellConfirm(
  analysis: ShellAnalysisResult,
  command?: string,
  shellConfig?: ShellConfig | null
): boolean {
  if (analysis.verdict === 'deny') return false
  if (command && shouldSkipShellConfirmForTrust(command, analysis, shellConfig)) return true
  if (analysis.shellSecurityHints.requiresRiskAck) return false
  if (analysis.permissionDecision === 'allow') return true
  return false
}

export function needsRiskAckOnConfirm(analysis: ShellAnalysisResult): boolean {
  return analysis.shellSecurityHints.requiresRiskAck
}
