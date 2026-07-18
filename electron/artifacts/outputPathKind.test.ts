import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveOutputPathKind } from './outputPathKind'

describe('resolveOutputPathKind', () => {
  it('uses lstat for an existing target and rejects a conflicting explicit declaration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-path-kind-'))
    try {
      await fs.mkdir(path.join(root, 'report'))

      await expect(resolveOutputPathKind({ targetPath: path.join(root, 'report'), declaredKind: 'file' })).rejects.toThrow(
        'ARTIFACT_PATH_TYPE_CONFLICT'
      )
      await expect(resolveOutputPathKind({ targetPath: path.join(root, 'report'), declaredKind: 'auto' })).resolves.toBe('directory')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each(['reports/', 'reports\\'])('treats an absent path with trailing separator as a directory: %s', async (requestedPath) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-path-kind-'))
    try {
      await expect(resolveOutputPathKind({
        targetPath: path.join(root, 'reports'),
        requestedPath,
        declaredKind: 'auto'
      })).resolves.toBe('directory')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
