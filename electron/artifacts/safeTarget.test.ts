import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveArtifactSafeTarget } from './safeTarget'

describe('resolveArtifactSafeTarget', () => {
  it.each(['../escape.txt', '/tmp/escape.txt', 'C:\\temp\\escape.txt', '\\\\server\\share\\escape.txt'])(
    'rejects unsafe target %s without normalizing it into a workspace path',
    async (target) => {
      await expect(resolveArtifactSafeTarget('/tmp/workspace', target)).rejects.toThrow(/artifact path/i)
    }
  )

  it('rejects symlink and directory write targets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-safe-target-'))
    try {
      await fs.mkdir(path.join(root, 'directory'))
      await fs.writeFile(path.join(root, 'file.txt'), 'x')
      await fs.symlink(path.join(root, 'file.txt'), path.join(root, 'link.txt'))

      await expect(resolveArtifactSafeTarget(root, 'link.txt')).rejects.toThrow(/符号链接/)
      await expect(resolveArtifactSafeTarget(root, 'directory')).rejects.toThrow(/普通文件/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rechecks the workspace identity before resolving a mutation target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-safe-target-'))
    try {
      await expect(resolveArtifactSafeTarget(root, 'report.txt', `${root}-moved`)).rejects.toThrow('ARTIFACT_WORKSPACE_CHANGED')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
