import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionDirectoryGrantRecord } from '../../src/shared/sessionDirectoryGrant'
import { matchSessionDirectoryGrant } from './sessionDirectoryGrantMatcher'

const roots: string[] = []
async function tempDir() { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'grant-match-')); roots.push(value); return value }
afterEach(async () => { await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true }))) })
async function grant(root: string, sessionId = 's1'): Promise<SessionDirectoryGrantRecord> {
  const realPath = await fs.realpath(root)
  const stat = await fs.stat(realPath)
  return { grantId: 'g1', sessionId, path: realPath, realPath, identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode }, createdAt: 1, source: 'user-selected-directory' }
}

describe('session directory grant matching', () => {
  it('matches only current desktop session paths contained in the selected real directory', async () => {
    const parent = await tempDir()
    const root = path.join(parent, 'selected')
    const sibling = path.join(parent, 'selected-secret')
    await fs.mkdir(root); await fs.mkdir(sibling)
    const target = path.join(root, 'note.txt'); await fs.writeFile(target, 'ok')
    const selected = await grant(root)
    expect(selected).toMatchObject({ sessionId: 's1', source: 'user-selected-directory', identity: expect.any(Object) })
    const canonicalTarget = await fs.realpath(target)
    await expect(matchSessionDirectoryGrant({ grants: [selected], sessionId: 's1', lane: 'desktop', targetPath: canonicalTarget })).resolves.toMatchObject({ grantId: 'g1' })
    await expect(matchSessionDirectoryGrant({ grants: [selected], sessionId: 'other', lane: 'desktop', targetPath: canonicalTarget })).resolves.toBeUndefined()
    await expect(matchSessionDirectoryGrant({ grants: [selected], sessionId: 's1', lane: 'feishu', targetPath: canonicalTarget })).resolves.toBeUndefined()
    await expect(matchSessionDirectoryGrant({ grants: [selected], sessionId: 's1', lane: 'desktop', targetPath: path.join(sibling, 'note.txt') })).resolves.toBeUndefined()
  })

  it('rejects symlinks whose real target leaves the selected subtree and replaced roots', async () => {
    const parent = await tempDir()
    const root = path.join(parent, 'selected')
    const outside = path.join(parent, 'outside')
    await fs.mkdir(root); await fs.mkdir(outside)
    const target = path.join(outside, 'secret.txt'); await fs.writeFile(target, 'secret')
    const link = path.join(root, 'link.txt'); await fs.symlink(target, link)
    const selected = await grant(root)
    await expect(matchSessionDirectoryGrant({ grants: [selected], sessionId: 's1', lane: 'desktop', targetPath: await fs.realpath(link) })).resolves.toBeUndefined()
    const moved = `${root}-moved`
    await fs.rename(root, moved); await fs.mkdir(root)
    await expect(matchSessionDirectoryGrant({ grants: [selected], sessionId: 's1', lane: 'desktop', targetPath: path.join(root, 'x') })).resolves.toBeUndefined()
  })
})
