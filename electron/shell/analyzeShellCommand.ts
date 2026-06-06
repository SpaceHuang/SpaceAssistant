import { parseShellSegments } from './shellCommandParser'
import { analyzeSegmentPaths } from './shellPathAnalysis'
import { evaluateShellPermission } from './shellPermissions'
import {
  buildSecurityContext,
  getShellSecurityDenyMessage,
  getShellSecurityWarningMessage,
  runShellSecurityValidators
} from './shellSecurity'
import type { ShellAnalysisResult } from './shellTypes'
import type { ShellConfig } from '../../src/shared/domainTypes'
import { shouldSkipShellConfirmForTrust } from './shellCommandTrust'
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
      validatorId: sec.validatorId,
      denyType: sec.denyType ?? 'strong',
      segments,
      pathVerdict,
      permissionDecision: perm.decision,
      shellSecurityHints: buildHints(pathVerdict, sec.validatorId, sec.denyType)
    }
  }

  if (sec.verdict === 'ask' && sec.validatorId && sec.denyType === 'weak') {
    const securityWarning = getShellSecurityWarningMessage(sec.validatorId)
    const hints = buildHints(pathVerdict, sec.validatorId, 'weak', securityWarning)
    return {
      verdict: 'ask',
      validatorId: sec.validatorId,
      denyType: 'weak',
      segments,
      pathVerdict,
      permissionDecision: perm.decision,
      shellSecurityHints: hints
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
