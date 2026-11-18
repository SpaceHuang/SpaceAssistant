import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { grepIgnoreContextDigest } from './grepIgnoreContext'
import { canCreateSymlinks } from '../../src/test/symlinkCapability'

describe('grep inherited-scope ignore context', () => {
  it('includes descendant ignore files in the parent-range fingerprint', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-ignore-context-')))
    const child = path.join(root, 'child')
    await fs.mkdir(child)
    try {
      const before = await grepIgnoreContextDigest(root, root)
      expect(before).toMatch(/^[a-f0-9]{64}$/)
      await fs.writeFile(path.join(child, '.gitignore'), 'private/\n')
      const after = await grepIgnoreContextDigest(root, root)
      expect(after).toMatch(/^[a-f0-9]{64}$/)
      expect(after).not.toBe(before)
      expect(await grepIgnoreContextDigest(root, root)).toBe(after)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('includes ignore files above the work directory in the range fingerprint', async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-ignore-ancestor-')))
    const workDir = path.join(parent, 'workspace')
    await fs.mkdir(workDir)
    try {
      const before = await grepIgnoreContextDigest(workDir, workDir)
      await fs.writeFile(path.join(parent, '.ignore'), 'private/\n')
      const after = await grepIgnoreContextDigest(workDir, workDir)
      expect(after).not.toBe(before)
    } finally { await fs.rm(parent, { recursive: true, force: true }) }
  })

  it.skipIf(!canCreateSymlinks())('fails closed on a symlinked ignore file', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-ignore-symlink-')))
    try {
      await fs.writeFile(path.join(root, 'rules.txt'), 'private/\n')
      await fs.symlink(path.join(root, 'rules.txt'), path.join(root, '.gitignore'))
      await expect(grepIgnoreContextDigest(root, root)).resolves.toBeUndefined()
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})
