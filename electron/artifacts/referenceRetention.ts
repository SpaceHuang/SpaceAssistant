export type ReferenceRetentionMode = 'retrieve' | 'short-summary' | 'long-term' | 'save'

/** Only user-directed long-term/save operations may enter the artifact retention flow. */
export function shouldRetainReferenceArtifact(input: { mode: ReferenceRetentionMode }): boolean {
  return input.mode === 'long-term' || input.mode === 'save'
}

export function resolveReferenceRetention(input: { mode: ReferenceRetentionMode; packageId?: string }):
  | { kind: 'none' }
  | { kind: 'package-reference'; packageId: string }
  | { kind: 'reference-retention'; choices: ['long-term', 'pending', 'cancel'] } {
  if (!shouldRetainReferenceArtifact(input)) return { kind: 'none' }
  if (input.packageId) return { kind: 'package-reference', packageId: input.packageId }
  return { kind: 'reference-retention', choices: ['long-term', 'pending', 'cancel'] }
}
