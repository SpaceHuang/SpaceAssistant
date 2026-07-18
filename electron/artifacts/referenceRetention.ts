export type ReferenceRetentionMode = 'retrieve' | 'short-summary' | 'long-term' | 'save'

/** Only user-directed long-term/save operations may enter the artifact retention flow. */
export function shouldRetainReferenceArtifact(input: { mode: ReferenceRetentionMode }): boolean {
  return input.mode === 'long-term' || input.mode === 'save'
}
