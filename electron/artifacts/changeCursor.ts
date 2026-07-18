import type { ArtifactContainer, ArtifactRole, PrimaryStage } from '../../src/shared/artifactTypes'

export type ArtifactChangeEntry = {
  artifactId: string
  container: ArtifactContainer
  role: ArtifactRole
  finalPath: string
  stage?: PrimaryStage
}

export class ArtifactChangeCursor {
  private readonly changed: ArtifactChangeEntry[] = []

  constructor(private readonly requestId: string) {}

  record(input: ArtifactChangeEntry & { requestId: string; success: boolean }): void {
    if (input.requestId !== this.requestId || !input.success) return
    this.changed.push({
      artifactId: input.artifactId,
      container: input.container,
      role: input.role,
      finalPath: input.finalPath,
      ...(input.stage ? { stage: input.stage } : {})
    })
  }

  entries(): readonly ArtifactChangeEntry[] {
    return this.changed
  }
}
