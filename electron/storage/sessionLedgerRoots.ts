import path from 'node:path'

/** Pure configured workspace-root resolution shared by storage tooling and ledger recovery. */
export function getSessionLedgerRoots(configuredWorkDir: string | undefined, profilesJson: string | undefined): string[] {
  const roots: string[] = []
  if (typeof configuredWorkDir === 'string' && configuredWorkDir.trim()) roots.push(path.resolve(configuredWorkDir))
  if (profilesJson) {
    try {
      const profiles: unknown = JSON.parse(profilesJson)
      if (Array.isArray(profiles)) {
        for (const profile of profiles) {
          if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue
          const profilePath = (profile as { path?: unknown }).path
          if (typeof profilePath === 'string' && profilePath.trim()) roots.push(path.resolve(profilePath))
        }
      }
    } catch {
      // Invalid profile configuration must not erase the primary configured workspace root.
    }
  }
  return [...new Set(roots)]
}
