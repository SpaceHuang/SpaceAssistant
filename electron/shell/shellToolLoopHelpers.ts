import { logShellAgentEvent } from './shellAgentLogger'
import { analyzeShellCommand, canSkipShellConfirm } from './analyzeShellCommand'
import {
  canShowShellTrustOption,
  matchesTrustedCommand,
  touchTrustedCommand
} from './shellCommandTrust'
import type { AppDatabase } from '../database'
import type { ShellAnalysisResult } from './shellTypes'
import type { ShellConfig, ShellSecurityHints } from '../../src/shared/domainTypes'

export type RunShellPrecheckResult =
  | {
      ok: false
      error: string
      auditReason: string
      validatorId?: string
      denyType?: 'strong' | 'weak'
    }
  | { ok: true; analysis: ShellAnalysisResult; skipConfirm: boolean; hints: ShellSecurityHints }

export async function precheckRunShellTool(args: {
  command: string
  workDir: string
  userDataDir: string
  shellConfig?: ShellConfig | null
  appDb?: AppDatabase | null
}): Promise<RunShellPrecheckResult> {
  const analysis = await analyzeShellCommand(
    args.workDir,
    args.command,
    process.platform,
    args.shellConfig,
    args.userDataDir
  )

  if (analysis.verdict === 'deny') {
    return {
      ok: false,
      error: analysis.denyReason ?? '命令未通过安全检查，已拒绝执行',
      auditReason: analysis.denyReason ?? 'security_deny',
      validatorId: analysis.validatorId,
      denyType: analysis.denyType ?? 'strong'
    }
  }

  const skipConfirm = canSkipShellConfirm(analysis, args.command, args.shellConfig)
  if (skipConfirm && args.appDb && matchesTrustedCommand(args.command, args.shellConfig?.trustedCommands)) {
    touchTrustedCommand(args.appDb, args.command)
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
    canTrust: canShowShellTrustOption(analysis)
  }

  return {
    ok: true,
    analysis,
    skipConfirm,
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
