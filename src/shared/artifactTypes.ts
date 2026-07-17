export type ArtifactContainer = 'project' | 'package' | 'scratch'

export type ArtifactRole = 'primary' | 'supporting' | 'reference' | 'scratch'

export type PrimaryStage = 'working' | 'draft' | 'final'

export type ArtifactPathSource =
  | 'user'
  | 'user-decision'
  | 'project-convention'
  | 'agent-default'
  | 'system-assigned'

export type ArtifactPathProvenance =
  | { pathSource: 'user'; pathEvidenceId: string; pathDecisionId?: never }
  | { pathSource: 'user-decision'; pathDecisionId: string; pathEvidenceId?: never }
  | { pathSource: 'project-convention'; pathEvidenceId?: never; pathDecisionId?: never }
  | { pathSource: 'agent-default'; pathEvidenceId?: never; pathDecisionId?: never }
  | { pathSource: 'system-assigned'; pathEvidenceId?: never; pathDecisionId?: never }
