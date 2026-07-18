import { assertArtifactWorkspaceIdentity } from './workspaceRecheck'

/**
 * Shared pre-mutation guard for relocate (and other destructive artifact ops).
 * RelocateService must call this before creating an operation journal.
 */
export async function assertRelocateWorkspaceReady(input: {
  workDir: string
  expectedWorkspaceRootReal: string
}): Promise<void> {
  await assertArtifactWorkspaceIdentity(input)
}
