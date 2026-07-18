import { isArtifactManagementEnabled } from './featureFlag'

const WRITE_DIR_CHOICE_KEY = 'writeDirChoice'

/** Legacy extension redirect and write-dir confirm apply only outside artifact-managed sessions. */
export function shouldApplyLegacyWorkspaceLayout(
  metadata: Record<string, unknown>,
  layoutEnabled: boolean
): boolean {
  return layoutEnabled && !isArtifactManagementEnabled(metadata)
}

/**
 * Artifact sessions ignore legacy writeDirChoice at runtime and drop it on the next normal save.
 * writeDirChoice is never migrated to artifactDefaultDir.
 */
export function sanitizeArtifactSessionMetadataOnSave(metadata: Record<string, unknown>): {
  metadata: Record<string, unknown>
  changed: boolean
} {
  if (!isArtifactManagementEnabled(metadata)) {
    return { metadata, changed: false }
  }
  if (!(WRITE_DIR_CHOICE_KEY in metadata)) {
    return { metadata, changed: false }
  }
  const next = { ...metadata }
  delete next[WRITE_DIR_CHOICE_KEY]
  return { metadata: next, changed: true }
}

/** Resolves artifact default dir without falling back to legacy writeDirChoice. */
export function resolveArtifactDefaultDir(metadata: Record<string, unknown>): string | undefined {
  const dir = metadata.artifactDefaultDir
  if (typeof dir === 'string' && dir.trim()) return dir.trim()
  return undefined
}
