import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertArtifactWorkspaceIdentity } from './workspaceRecheck'

describe('assertArtifactWorkspaceIdentity', () => {
  it('rejects a mutation when the workspace realpath differs from its resolution snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-workspace-recheck-'))
    try {
      await expect(assertArtifactWorkspaceIdentity({ workDir: root, expectedWorkspaceRootReal: `${root}-moved` })).rejects.toThrow(
        'ARTIFACT_WORKSPACE_CHANGED'
      )
      await expect(assertArtifactWorkspaceIdentity({ workDir: root, expectedWorkspaceRootReal: await fs.realpath(root) })).resolves.toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
