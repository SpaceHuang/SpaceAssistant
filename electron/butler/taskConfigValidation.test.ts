import { mkdtemp, mkdir, writeFile, rm, realpath, chmod, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { taskAuthorizedRootSetMatchesSnapshot, validateTaskAuthorizedDirsForRun, validateTaskWorkDir } from './taskConfigValidation'

const dirs: string[] = []
const directorySymlinkType = process.platform === 'win32' ? 'junction' : 'dir'
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('task work directory validation', () => {
  it('returns canonical absolute existing directory path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-root-'))
    dirs.push(root)
    const alias = join(root, 'alias')
    await mkdir(alias)
    expect(await validateTaskWorkDir(alias)).toEqual({ ok: true, workDir: await realpath(alias) })
  })
  it.each(['', 'relative/path'])('rejects missing or relative explicit paths: %s', async (value) => {
    expect(await validateTaskWorkDir(value)).toMatchObject({ ok: false })
  })
  it('rejects files and missing paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-file-'))
    dirs.push(root)
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')
    expect(await validateTaskWorkDir(file)).toMatchObject({ ok: false, error: '任务工作目录必须是目录' })
    expect(await validateTaskWorkDir(join(root, 'missing'))).toMatchObject({ ok: false, error: '任务工作目录不存在或不可访问' })
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects a directory without read permission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-no-read-'))
    dirs.push(root)
    const inaccessible = join(root, 'private')
    await mkdir(inaccessible)
    await chmod(inaccessible, 0o300)
    try {
      expect(await validateTaskWorkDir(inaccessible)).toMatchObject({ ok: false, error: '任务工作目录不存在或不可访问' })
    } finally {
      await chmod(inaccessible, 0o700)
    }
  })
})

import { validateTaskWorkDirs } from './taskConfigValidation'

describe('task work directory set validation', () => {
  it('requires a non-empty array and canonicalizes, deduplicates, and sorts roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-roots-'))
    dirs.push(root)
    const child = join(root, 'child')
    await mkdir(child)
    const [canonicalRoot, canonicalChild] = await Promise.all([realpath(root), realpath(child)])
    const result = await validateTaskWorkDirs([child, root, child])
    expect(result).toEqual({ ok: true, workDirs: [canonicalChild, canonicalRoot].sort() })
    expect(await validateTaskWorkDirs([])).toMatchObject({ ok: false })
  })

  it('fails the whole roots set when any entry is not an accessible directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-roots-partial-'))
    dirs.push(root)
    await expect(validateTaskWorkDirs([root, join(root, 'missing')])).resolves.toMatchObject({ ok: false })
    await expect(validateTaskWorkDirs([root, 'relative'])).resolves.toMatchObject({ ok: false })
  })
})

describe('approved automation root revalidation', () => {
  it('accepts unchanged canonical roots and rejects a changed resolved set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-approved-root-'))
    dirs.push(root)
    const other = join(root, 'other')
    await mkdir(other)
    const [canonicalRoot, canonicalOther] = await Promise.all([realpath(root), realpath(other)])

    await expect(validateTaskAuthorizedDirsForRun([canonicalRoot], [canonicalRoot])).resolves.toEqual({ ok: true, authorizedDirs: [canonicalRoot] })
    expect(taskAuthorizedRootSetMatchesSnapshot([canonicalRoot], [canonicalOther])).toBe(false)
  })

  it('rejects the approved root itself when it is replaced by a symlink', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'automation-approved-root-link-'))
    dirs.push(parent)
    const approved = join(parent, 'approved')
    const moved = join(parent, 'approved-original')
    const outside = join(parent, 'outside')
    await mkdir(approved)
    await mkdir(outside)
    const approvedSnapshot = await realpath(approved)
    await rename(approved, moved)
    await symlink(outside, approved, directorySymlinkType)

    await expect(validateTaskAuthorizedDirsForRun([approved], [approvedSnapshot])).resolves.toEqual({ ok: false, error: 'TASK_AUTHORIZED_ROOT_DRIFT' })
  })

  it('rejects an approved root whose ancestor is replaced by a symlink', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'automation-approved-ancestor-'))
    dirs.push(parent)
    const originalParent = join(parent, 'original-parent')
    const replacementParent = join(parent, 'replacement-parent')
    const parentLink = join(parent, 'authorized-parent')
    await mkdir(join(originalParent, 'project'), { recursive: true })
    await mkdir(join(replacementParent, 'project'), { recursive: true })
    await symlink(originalParent, parentLink, directorySymlinkType)
    const approvedSnapshot = await realpath(join(parentLink, 'project'))
    await rename(originalParent, join(parent, 'original-parent-moved'))
    await rm(parentLink)
    await symlink(replacementParent, parentLink, directorySymlinkType)

    await expect(validateTaskAuthorizedDirsForRun([join(parentLink, 'project')], [approvedSnapshot])).resolves.toEqual({ ok: false, error: 'TASK_AUTHORIZED_ROOT_DRIFT' })
  })

  it('rejects the entire roots set when only one of several approved roots drifts', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'automation-approved-roots-partial-drift-'))
    dirs.push(parent)
    const stable = join(parent, 'stable')
    const approved = join(parent, 'approved')
    const moved = join(parent, 'approved-original')
    const outside = join(parent, 'outside')
    await Promise.all([mkdir(stable), mkdir(approved), mkdir(outside)])
    const approvedSnapshot = await realpath(approved)
    const stableSnapshot = await realpath(stable)
    await rename(approved, moved)
    await symlink(outside, approved, directorySymlinkType)

    await expect(validateTaskAuthorizedDirsForRun([stable, approved], [stableSnapshot, approvedSnapshot])).resolves.toEqual({ ok: false, error: 'TASK_AUTHORIZED_ROOT_DRIFT' })
  })
})
