import type { DeclaredArtifactPathProvenance } from '../src/shared/artifactTypes'

export const validUserProvenance: DeclaredArtifactPathProvenance = {
  pathSource: 'user',
  pathEvidenceId: 'evidence-1'
}

export const rejectedUserDecision: DeclaredArtifactPathProvenance = {
  // @ts-expect-error Agent calls cannot claim a main-process decision.
  pathSource: 'user-decision',
  // @ts-expect-error Agent calls cannot provide a decision ID.
  pathDecisionId: 'decision-1'
}

export const rejectedSystemAssigned: DeclaredArtifactPathProvenance = {
  // @ts-expect-error Agent calls cannot claim a system-assigned path.
  pathSource: 'system-assigned'
}

// @ts-expect-error Only user provenance can carry an evidence ID.
export const rejectedNonUserEvidence: DeclaredArtifactPathProvenance = {
  pathSource: 'project-convention',
  pathEvidenceId: 'evidence-2'
}
