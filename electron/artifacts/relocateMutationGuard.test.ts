import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertRelocateWorkspaceReady } from './relocateMutationGuard'

describe('assertRelocateWorkspaceReady', () => {
  it('rejects relocate preparation when workspace identity drifted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-relocate-guard-'))
    try {
      await expect(
        assertRelocateWorkspaceReady({ workDir: root, expectedWorkspaceRootReal: `${root}-moved` })
      ).rejects.toThrow('ARTIFACT_WORKSPACE_CHANGED')
      await expect(
        assertRelocateWorkspaceReady({ workDir: root, expectedWorkspaceRootReal: await fs.realpath(root) })
      ).resolves.toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
