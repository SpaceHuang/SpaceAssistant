export type ArtifactContainer = 'project' | 'package' | 'scratch'

export type ArtifactRole = 'primary' | 'supporting' | 'reference' | 'scratch'

export type PrimaryStage = 'working' | 'draft' | 'final'

export type ArtifactPathSource =
  | 'user'
  | 'user-decision'
  | 'project-convention'
  | 'agent-default'
  | 'system-assigned'
