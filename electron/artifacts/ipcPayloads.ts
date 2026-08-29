/** Transitional payload types mirroring the shape previously re-exported from src/shared/api. */
export type ArtifactApiItem = {
  id: string
  sessionId: string
  container: 'project' | 'package' | 'scratch'
  role: 'primary' | 'supporting' | 'reference' | 'scratch'
  title: string
  finalPath: string
  status: 'active' | 'deleted'
  stage?: 'working' | 'draft' | 'final'
  packageId?: string
}

export type ArtifactDecisionResponsePayload = {
  decisionId: string
  requestId: string
  sessionId: string
  toolUseId: string
  attempt: number
  choice: string
}
