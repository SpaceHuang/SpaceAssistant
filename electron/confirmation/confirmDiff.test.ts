import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildConfirmationDiff } from './confirmDiff'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('buildConfirmationDiff', () => {
  it('projects a write_file overwrite using the current workspace content', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'confirm-diff-write-'))
    tempDirs.push(workDir)
    await fs.writeFile(path.join(workDir, 'note.txt'), 'before')

    await expect(buildConfirmationDiff(workDir, 'write_file', { path: 'note.txt', content: 'after' })).resolves.toEqual({
      oldPath: 'note.txt', oldContent: 'before', newContent: 'after'
    })
  })

  it('projects an edit_file replacement and leaves unmatched edits unchanged', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'confirm-diff-edit-'))
    tempDirs.push(workDir)
    await fs.writeFile(path.join(workDir, 'note.txt'), 'one target')

    await expect(buildConfirmationDiff(workDir, 'edit_file', {
      path: 'note.txt', old_string: 'target', new_string: 'replacement'
    })).resolves.toEqual({ oldPath: 'note.txt', oldContent: 'one target', newContent: 'one replacement' })
    await expect(buildConfirmationDiff(workDir, 'edit_file', {
      path: 'note.txt', old_string: 'missing', new_string: 'replacement'
    })).resolves.toEqual({ oldPath: 'note.txt', oldContent: 'one target', newContent: 'one target' })
  })
})
