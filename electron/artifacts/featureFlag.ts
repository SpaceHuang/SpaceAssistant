export const ARTIFACT_MANAGEMENT_ENABLED_KEY = 'artifactManagementEnabled'

export function isArtifactManagementEnabled(metadata: Record<string, unknown>): boolean {
  return metadata[ARTIFACT_MANAGEMENT_ENABLED_KEY] === true
}

export function freezeArtifactManagementFlag(metadata: Record<string, unknown>, enabled: boolean | undefined): Record<string, unknown> {
  if (ARTIFACT_MANAGEMENT_ENABLED_KEY in metadata) return metadata
  return { ...metadata, [ARTIFACT_MANAGEMENT_ENABLED_KEY]: enabled === true }
}

/** Legacy extension redirects are permitted only for sessions outside the new artifact flow. */
export function shouldUseLegacyWorkspaceRedirect(metadata: Record<string, unknown>): boolean {
  return !isArtifactManagementEnabled(metadata)
}
