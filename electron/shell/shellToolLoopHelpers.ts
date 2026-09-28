import { logShellAgentEvent } from './shellAgentLogger'
import { analyzeShellCommand } from './analyzeShellCommand'
import {
  canShowShellTrustOption,
  matchesTrustedCommand,
  touchTrustedCommand,
  parseSimpleShellCommand
} from './shellCommandTrust'
import type { AppDatabase } from '../database'
import type { ShellAnalysisResult } from './shellTypes'
import type { ShellConfig, ShellSecurityHints } from '../../src/shared/domainTypes'
import { adaptLegacyShellConfig, type LegacyShellPolicyInput } from './legacyShellPolicyAdapter'
import { profileForPlatform } from './shellProfiles'

export type RunShellPrecheckResult =
  | {
      ok: false
      error: string
      auditReason: string
      validatorId?: string
      denyType?: 'strong' | 'weak'
    }
  | { ok: true; analysis: ShellAnalysisResult; legacyAutoAllowEligible: boolean; legacyPolicy: LegacyShellPolicyInput; hints: ShellSecurityHints }

export async function precheckRunShellTool(args: {
  command: string
  workDir: string
  userDataDir: string
  shellConfig?: ShellConfig | null
  /** P2 端口化：trusted-command 记账写经端口注入（真相类，不允许静默停写）。 */
  shellPrecheck?: { touchTrustedCommand: (command: string) => void } | null
}): Promise<RunShellPrecheckResult> {
  const analysis = await analyzeShellCommand(
    args.workDir,
    args.command,
    process.platform,
    args.shellConfig,
    args.userDataDir
  )

  // R5：仅 deny 预检短路；unsupported 不再产出 shellPrecheckDeny——
  // 该事实随 analysis 下传，由 gate 提取为 shell-unsupported-structure 信号走引擎（§4.5.1 零特例）
  // B2（评审 2026-09-28）：段数超限保留结构化短路——gate 的 extractor 会裸调
  // parseShellSegments（无捕获），>50 段命令会以未捕获异常炸掉整轮工具循环；
  // 该类命令本就无法安全分析，fail-closed 且错误形态可读。
  if (analysis.verdict === 'unsupported' && analysis.unsupportedReason === 'too-many-segments') {
    return {
      ok: false,
      error: analysis.denyReason ?? '命令段数过多，无法进行安全分析，已拒绝执行',
      auditReason: analysis.denyReason ?? 'too_many_segments',
      denyType: 'strong'
    }
  }
  if (analysis.verdict === 'deny') {
    return {
      ok: false,
      error: analysis.denyReason ?? '命令未通过安全检查，已拒绝执行',
      auditReason: analysis.denyReason ?? 'security_deny',
      validatorId: analysis.validatorId,
      denyType: analysis.denyType ?? 'strong'
    }
  }

  const profile = profileForPlatform(process.platform)
  const legacyPolicy = adaptLegacyShellConfig(args.command, analysis.segments, args.shellConfig, `${profile.id}:${profile.dialect}`)
  const parsedCommand = parseSimpleShellCommand(args.command)
  const analysisComplete = analysis.facts?.analysisCompleteness === 'complete'
  const legacyAutoAllowEligible = analysisComplete && parsedCommand.persistable && !parsedCommand.hasMetasyntax &&
    !analysis.shellSecurityHints.requiresRiskAck &&
    (legacyPolicy.permissionDecision === 'allow' || legacyPolicy.trustedCacheKeys.length > 0)
  if (legacyAutoAllowEligible && matchesTrustedCommand(args.command, args.shellConfig?.trustedCommands)) {
    args.shellPrecheck?.touchTrustedCommand(args.command)
  }
  const hints: ShellSecurityHints = {
    requiresRiskAck: analysis.shellSecurityHints.requiresRiskAck,
    outsideWorkDirRisk: analysis.shellSecurityHints.outsideWorkDirRisk,
    warnings: analysis.shellSecurityHints.warnings,
    scannedPaths: analysis.shellSecurityHints.scannedPaths,
    violationCodes: analysis.shellSecurityHints.violationCodes,
    validatorId: analysis.shellSecurityHints.validatorId,
    denyType: analysis.shellSecurityHints.denyType,
    securityWarning: analysis.shellSecurityHints.securityWarning,
    canTrust: canShowShellTrustOption(analysis, args.command)
  }

  return {
    ok: true,
    analysis,
    legacyAutoAllowEligible,
    legacyPolicy,
    hints
  }
}

export function logShellSecurityDeny(args: {
  requestId: string
  sessionId: string
  command: string
  reason: string
  validatorId?: string
  denyType?: 'strong' | 'weak'
  violationCodes?: string[]
}): void {
  logShellAgentEvent('info', 'shell.security.deny', {
    requestId: args.requestId,
    sessionId: args.sessionId,
    command: args.command,
    reason: args.reason,
    validatorId: args.validatorId,
    denyType: args.denyType ?? 'strong',
    userAction: 'blocked',
    violationCodes: args.violationCodes
  })
}

export function logShellPathConfirm(args: {
  requestId: string
  sessionId: string
  command: string
  outcome: 'confirm' | 'reject'
  hints: ShellSecurityHints
}): void {
  const event = args.outcome === 'confirm' ? 'shell.path.confirm' : 'shell.path.reject'
  logShellAgentEvent('info', event, {
    requestId: args.requestId,
    sessionId: args.sessionId,
    command: args.command,
    warnings: args.hints.warnings,
    violationCodes: args.hints.violationCodes,
    validatorId: args.hints.validatorId,
    denyType: args.hints.denyType,
    userAction: args.outcome === 'confirm' ? 'confirmed' : 'cancelled'
  })
}

export function logShellWeakDenyOutcome(args: {
  requestId: string
  sessionId: string
  command: string
  outcome: 'confirm' | 'reject'
  hints: ShellSecurityHints
}): void {
  logShellAgentEvent('info', 'shell.security.deny', {
    requestId: args.requestId,
    sessionId: args.sessionId,
    command: args.command,
    validatorId: args.hints.validatorId,
    reason: args.hints.securityWarning,
    denyType: args.hints.denyType ?? 'weak',
    userAction: args.outcome === 'confirm' ? 'confirmed' : 'cancelled',
    violationCodes: args.hints.violationCodes
  })
}
