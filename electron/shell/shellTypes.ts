export type ShellSecurityVerdict = 'allow' | 'deny' | 'ask'

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

export interface ShellAnalysisResult {
  verdict: ShellSecurityVerdict
  denyReason?: string
  pathVerdict: ShellPathVerdict
  segments: string[]
  shellSecurityHints: {
    requiresRiskAck: boolean
    outsideWorkDirRisk: boolean
    warnings: string[]
    scannedPaths?: string[]
    violationCodes?: string[]
  }
  permissionDecision?: 'allow' | 'deny' | 'ask'
}
