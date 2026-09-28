import type { ShellDialect } from './shellProfiles'

export type ShellSecurityVerdict = 'allow' | 'deny' | 'ask' | 'unsupported'

export type ShellSecurityDenyType = 'strong' | 'weak'

export interface ShellPathLiteral {
  raw: string
  resolved?: string
  segmentIndex: number
  kind: 'arg' | 'cd-target' | 'flag-value'
}

export interface ShellPathVerdict {
  decision: 'allow' | 'deny' | 'ask'
  violations: Array<{ code: string; message: string; path?: string; severity: 'warning' | 'block' }>
  warnings: string[]
  outsideWorkDirRisk: boolean
  requiresRiskAck: boolean
}

export interface ShellSecurityContext {
  command: string
  platform: NodeJS.Platform
  workDir: string
  segments: string[]
  pathLiterals: ShellPathLiteral[]
  pathVerdict: ShellPathVerdict
}

export interface ShellSecurityCheckResult {
  verdict: ShellSecurityVerdict
  validatorId?: string
  denyType?: ShellSecurityDenyType
  denyReason?: string
}

export interface ShellAnalysisResult {
  verdict: ShellSecurityVerdict
  denyReason?: string
  validatorId?: string
  denyType?: ShellSecurityDenyType
  /** R5：verdict='unsupported' 时列出解析器不支持的结构（如 conditional-block / pipe-to-format） */
  unsupportedStructures?: string[]
  /** R5：unsupported 子原因（structure=结构不受支持；too-many-segments=段数超限） */
  unsupportedReason?: 'structure' | 'too-many-segments'
  pathVerdict: ShellPathVerdict
  segments: string[]
  shellSecurityHints: {
    requiresRiskAck: boolean
    outsideWorkDirRisk: boolean
    warnings: string[]
    scannedPaths?: string[]
    violationCodes?: string[]
    validatorId?: string
    denyType?: ShellSecurityDenyType
    securityWarning?: string
  }
  permissionDecision?: 'allow' | 'deny' | 'ask'
  /** 仅包含解析事实，不包含授权裁决；由统一 Analyzer 生成。 */
  facts?: {
    dialect: ShellDialect
    operations: readonly { verb: string; args: readonly string[]; segmentIndex: number }[]
    connectors: readonly string[]
    paths: readonly string[]
    redirects: readonly string[]
    cwdChanges: readonly string[]
    analysisCompleteness: 'complete' | 'partial'
    unresolved: readonly string[]
  }
}
