import type { DeclaredArtifactPathProvenance } from '../src/shared/artifactTypes'

export const validUserProvenance: DeclaredArtifactPathProvenance = {
  pathSource: 'user',
  pathEvidenceId: 'evidence-1'
}

// @ts-expect-error Agent calls cannot claim a main-process decision.
export const rejectedUserDecision: DeclaredArtifactPathProvenance = {
  pathSource: 'user-decision',
  pathDecisionId: 'decision-1'
}

// @ts-expect-error Agent calls cannot claim a system-assigned path.
export const rejectedSystemAssigned: DeclaredArtifactPathProvenance = {
  pathSource: 'system-assigned'
}
