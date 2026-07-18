export type ArtifactDecisionKind =
  | 'output-location'
  | 'path-type'
  | 'ownership'
  | 'overwrite'
  | 'reference-retention'
  | 'git-ignore'

export type ArtifactDecisionRequest = {
  decisionId: string
  requestId: string
  sessionId: string
  toolUseId: string
  attempt: number
  groupKey?: string
  kind: ArtifactDecisionKind
  title?: string
  message?: string
  options: Array<{ key: string; label: string; requiresInput?: 'rename' | 'directory' }>
  context?: Record<string, string>
}
