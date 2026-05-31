import { logShellAgentEvent } from './shellAgentLogger'
import { analyzeShellCommand, canSkipShellConfirm } from './analyzeShellCommand'
import type { ShellAnalysisResult } from './shellTypes'
import type { ShellConfig, ShellSecurityHints } from '../../src/shared/domainTypes'

export type RunShellPrecheckResult =
  | { ok: false; error: string; auditReason: string }
  | { ok: true; analysis: ShellAnalysisResult; skipConfirm: boolean; hints: ShellSecurityHints }

export async function precheckRunShellTool(args: {
  command: string
  workDir: string
  userDataDir: string
  shellConfig?: ShellConfig | null
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
      auditReason: analysis.denyReason ?? 'security_deny'
    }
  }

  const hints: ShellSecurityHints = {
    requiresRiskAck: analysis.shellSecurityHints.requiresRiskAck,
    outsideWorkDirRisk: analysis.shellSecurityHints.outsideWorkDirRisk,
    warnings: analysis.shellSecurityHints.warnings,
    scannedPaths: analysis.shellSecurityHints.scannedPaths,
    violationCodes: analysis.shellSecurityHints.violationCodes
  }

  return {
    ok: true,
    analysis,
    skipConfirm: canSkipShellConfirm(analysis),
    hints
  }
}

export function logShellSecurityDeny(args: {
  requestId: string
  sessionId: string
  command: string
  reason: string
  violationCodes?: string[]
}): void {
  logShellAgentEvent('info', 'shell.security.deny', {
    requestId: args.requestId,
    sessionId: args.sessionId,
    command: args.command,
    reason: args.reason,
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
    violationCodes: args.hints.violationCodes
  })
}
