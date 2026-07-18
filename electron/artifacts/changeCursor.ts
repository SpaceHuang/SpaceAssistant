import type { ArtifactContainer, ArtifactRole } from '../../src/shared/artifactTypes'

export type ArtifactChangeEntry = {
  artifactId: string
  container: ArtifactContainer
  role: ArtifactRole
  finalPath: string
}

export class ArtifactChangeCursor {
  private readonly changed: ArtifactChangeEntry[] = []

  constructor(private readonly requestId: string) {}

  record(input: ArtifactChangeEntry & { requestId: string; success: boolean }): void {
    if (input.requestId !== this.requestId || !input.success) return
    this.changed.push({ artifactId: input.artifactId, container: input.container, role: input.role, finalPath: input.finalPath })
  }

  entries(): readonly ArtifactChangeEntry[] {
    return this.changed
  }
}
