import type { ArtifactChangeEntry } from './changeCursor'

export type ArtifactCompletionSummary = {
  project: string[]
  package: string[]
  scratch: string[]
}

export function buildArtifactCompletionSummary(entries: readonly ArtifactChangeEntry[]): ArtifactCompletionSummary {
  const summary: ArtifactCompletionSummary = { project: [], package: [], scratch: [] }
  for (const entry of entries) summary[entry.container].push(entry.finalPath)
  return summary
}
