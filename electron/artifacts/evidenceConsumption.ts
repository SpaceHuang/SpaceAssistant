import type { ExplicitPathEvidence } from './explicitPathEvidence'

/** Request-scoped, one-shot consumption tracking for explicit output path evidence. */
export class ArtifactEvidenceConsumption {
  private readonly consumed = new Set<string>()

  constructor(private readonly evidence: readonly ExplicitPathEvidence[]) {}

  consume(evidenceId: string): void {
    const item = this.evidence.find((candidate) => candidate.evidenceId === evidenceId)
    if (!item) throw new Error(`Unknown artifact evidence: ${evidenceId}`)
    this.consumed.add(evidenceId)
  }

  unconsumedOutputEvidence(): ExplicitPathEvidence[] {
    return this.evidence.filter((item) => item.intent === 'output' && !this.consumed.has(item.evidenceId))
  }
}
