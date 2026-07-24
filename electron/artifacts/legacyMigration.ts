const WRITE_DIR_CHOICE_KEY = 'writeDirChoice'

/**
 * Drop legacy writeDirChoice on any session save. Never migrates it to artifactDefaultDir.
 */
export function sanitizeArtifactSessionMetadataOnSave(metadata: Record<string, unknown>): {
  metadata: Record<string, unknown>
  changed: boolean
} {
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
