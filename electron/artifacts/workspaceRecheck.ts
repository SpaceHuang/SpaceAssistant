import fs from 'node:fs/promises'
import { ErrorCodes } from '../../src/shared/errorCodes'

/** Revalidates the real workspace root immediately before a filesystem mutation. */
export async function assertArtifactWorkspaceIdentity(input: {
  workDir: string
  expectedWorkspaceRootReal: string
}): Promise<void> {
  let actual: string
  try {
    actual = await fs.realpath(input.workDir)
  } catch {
    throw new Error(`${ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE}: workspace cannot be resolved`)
  }
  if (actual !== input.expectedWorkspaceRootReal) {
    throw new Error(`${ErrorCodes.ARTIFACT_WORKSPACE_CHANGED}: workspace identity changed before mutation`)
  }
}
