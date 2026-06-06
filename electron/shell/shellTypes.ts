export type ShellSecurityVerdict = 'allow' | 'deny' | 'ask'

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
}
