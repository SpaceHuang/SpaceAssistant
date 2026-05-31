import { parseShellSegments } from './shellCommandParser'
import { analyzeSegmentPaths } from './shellPathAnalysis'
import { evaluateShellPermission } from './shellPermissions'
import {
  buildSecurityContext,
  getShellSecurityDenyMessage,
  runShellSecurityValidators
} from './shellSecurity'
import type { ShellAnalysisResult } from './shellTypes'
import type { ShellConfig } from '../../src/shared/domainTypes'
import type { ShellPathVerdict } from './shellTypes'

export async function analyzeShellCommand(
  workDir: string,
  command: string,
  platform: NodeJS.Platform,
  shellConfig?: ShellConfig | null,
  userDataDir?: string
): Promise<ShellAnalysisResult> {
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

  const perm = evaluateShellPermission(command, segments, shellConfig?.rules)
  if (perm.decision === 'deny') {
    return {
      verdict: 'deny',
      denyReason: perm.reason ?? '命令被规则拒绝',
      segments,
      pathVerdict,
      permissionDecision: 'deny',
      shellSecurityHints: buildHints(pathVerdict)
    }
  }

  const ctx = buildSecurityContext(command, platform, workDir, segments, pathVerdict, literals)
  const sec = runShellSecurityValidators(ctx)
  if (sec.verdict === 'deny') {
    return {
      verdict: 'deny',
      denyReason: getShellSecurityDenyMessage(sec.validatorId ?? ''),
      segments,
      pathVerdict,
      permissionDecision: perm.decision,
      shellSecurityHints: buildHints(pathVerdict)
    }
  }

  const hints = buildHints(pathVerdict)
  return {
    verdict: 'ask',
    segments,
    pathVerdict,
    permissionDecision: perm.decision,
    shellSecurityHints: hints
  }
}

function buildHints(pathVerdict: ShellPathVerdict) {
  const codes = pathVerdict.violations.map((v) => v.code)
  return {
    requiresRiskAck: pathVerdict.requiresRiskAck || pathVerdict.outsideWorkDirRisk,
    outsideWorkDirRisk: pathVerdict.outsideWorkDirRisk,
    warnings: pathVerdict.warnings,
    scannedPaths: pathVerdict.violations.map((v) => v.path).filter(Boolean) as string[],
    violationCodes: codes.length ? codes : undefined
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

/** 是否可跳过用户确认（allow 规则且无需风险确认） */
export function canSkipShellConfirm(
  analysis: ShellAnalysisResult,
  userConfirmedRisk?: boolean
): boolean {
  if (analysis.verdict === 'deny') return false
  if (analysis.shellSecurityHints.requiresRiskAck) return false
  if (analysis.permissionDecision === 'allow') return true
  return false
}

export function needsRiskAckOnConfirm(analysis: ShellAnalysisResult): boolean {
  return analysis.shellSecurityHints.requiresRiskAck
}
