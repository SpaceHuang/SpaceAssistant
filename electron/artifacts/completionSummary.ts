import type { PrimaryStage } from '../../src/shared/artifactTypes'
import type { ArtifactChangeEntry } from './changeCursor'

export type ArtifactCompletionSummaryItem = {
  finalPath: string
  stage?: PrimaryStage
}

export type ArtifactCompletionSummary = {
  project: ArtifactCompletionSummaryItem[]
  package: ArtifactCompletionSummaryItem[]
  scratch: ArtifactCompletionSummaryItem[]
}

export function buildArtifactCompletionSummary(entries: readonly ArtifactChangeEntry[]): ArtifactCompletionSummary {
  const summary: ArtifactCompletionSummary = { project: [], package: [], scratch: [] }
  for (const entry of entries) {
    summary[entry.container].push({
      finalPath: entry.finalPath,
      ...(entry.stage ? { stage: entry.stage } : {})
    })
  }
  return summary
}
