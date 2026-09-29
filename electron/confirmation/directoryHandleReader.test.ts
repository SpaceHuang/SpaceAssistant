import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDirectoryBoundToIdentity } from './directoryHandleReader'
import { writeFileAtomicallyBoundToDirectory } from './directoryHandleWriter'

const roots: string[] = []
async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-dir-handle-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('readDirectoryBoundToIdentity', () => {
  it('validates the worker cwd identity and enumerates children relative to that directory handle', async () => {
    const root = await tempDir()
    const target = path.join(root, 'target')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'visible.txt'), 'approved')
    const stat = await fs.stat(target)
    await expect(readDirectoryBoundToIdentity(await fs.realpath(target), {
      dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs
    })).resolves.toEqual({
      ok: true,
      entries: [{ name: 'visible.txt', isDirectory: false, size: 8, mtimeMs: expect.any(Number) }]
    })
  })

  it('rejects when the path now names a different directory identity', async () => {
    const root = await tempDir()
    const target = path.join(root, 'target')
    const moved = path.join(root, 'approved')
    await fs.mkdir(target)
    const stat = await fs.stat(target)
    await fs.rename(target, moved)
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'secret.txt'), 'secret')
    await expect(readDirectoryBoundToIdentity(await fs.realpath(target), {
      dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs
    })).resolves.toMatchObject({ ok: false, caseId: 'read-directory-identity-changed' })
  })

  it('kills and reaps an active worker when the caller signal aborts', async () => {
    const root = await tempDir()
    const target = path.join(root, 'target')
    await fs.mkdir(target)
    const stat = await fs.stat(target)
    const controller = new AbortController()
    const pending = readDirectoryBoundToIdentity(await fs.realpath(target), {
      dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs
    }, controller.signal)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, caseId: 'read-directory-cancelled' })
  })
})

describe('writeFileAtomicallyBoundToDirectory', () => {
  it('creates a new file relative to the permit-bound directory and returns its identity', async () => {
    const root = await tempDir()
    const targetDir = path.join(root, 'target')
    await fs.mkdir(targetDir)
    const stat = await fs.stat(targetDir)
    const result = await writeFileAtomicallyBoundToDirectory({
      directory: targetDir,
      expectedDirectoryIdentity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs },
      targetName: 'new.txt',
      body: Buffer.from('worker write'),
      expectedFileIdentity: null
    })
    expect(result).toMatchObject({ ok: true, identity: { dev: stat.dev, ino: expect.any(Number), size: 12, nlink: 1 } })
    expect(await fs.readFile(path.join(targetDir, 'new.txt'), 'utf8')).toBe('worker write')
  })

  it('streams large write payloads through stdin instead of the process argument list', async () => {
    const root = await tempDir()
    const targetDir = path.join(root, 'target')
    await fs.mkdir(targetDir)
    const directory = await fs.stat(targetDir)
    const body = Buffer.alloc(1024 * 1024, 0x61)
    const result = await writeFileAtomicallyBoundToDirectory({
      directory: targetDir,
      expectedDirectoryIdentity: { dev: directory.dev, ino: directory.ino, mode: directory.mode, size: directory.size, mtimeMs: directory.mtimeMs },
      targetName: 'large.bin',
      body,
      expectedFileIdentity: null
    })
    expect(result).toMatchObject({ ok: true, identity: { size: body.length } })
    expect(await fs.readFile(path.join(targetDir, 'large.bin'))).toEqual(body)
  })

  it('refuses a replacement directory and never writes through its symlink', async () => {
    const root = await tempDir()
    const targetDir = path.join(root, 'target')
    const outside = path.join(root, 'outside')
    await fs.mkdir(targetDir)
    await fs.mkdir(outside)
    const stat = await fs.stat(targetDir)
    await fs.rmdir(targetDir)
    await fs.symlink(outside, targetDir, 'dir')
    await expect(writeFileAtomicallyBoundToDirectory({
      directory: targetDir,
      expectedDirectoryIdentity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs },
      targetName: 'escaped.txt',
      body: Buffer.from('must not escape'),
      expectedFileIdentity: null
    })).resolves.toMatchObject({ ok: false, caseId: 'write-directory-identity-changed' })
    await expect(fs.access(path.join(outside, 'escaped.txt'))).rejects.toThrow()
  })

  it('overwrites only the file identity captured by the permit', async () => {
    const root = await tempDir()
    const targetDir = path.join(root, 'target')
    await fs.mkdir(targetDir)
    const target = path.join(targetDir, 'existing.txt')
    await fs.writeFile(target, 'old')
    const directory = await fs.stat(targetDir)
    const original = await fs.stat(target)
    const directoryIdentity = { dev: directory.dev, ino: directory.ino, mode: directory.mode, size: directory.size, mtimeMs: directory.mtimeMs }
    const fileIdentity = { dev: original.dev, ino: original.ino, mode: original.mode, size: original.size, mtimeMs: original.mtimeMs, nlink: original.nlink }
    await expect(writeFileAtomicallyBoundToDirectory({
      directory: targetDir, expectedDirectoryIdentity: directoryIdentity, targetName: 'existing.txt',
      body: 'new content', expectedFileIdentity: fileIdentity
    })).resolves.toMatchObject({ ok: true })
    expect(await fs.readFile(target, 'utf8')).toBe('new content')
    await expect(writeFileAtomicallyBoundToDirectory({
      directory: targetDir, expectedDirectoryIdentity: directoryIdentity, targetName: 'existing.txt',
      body: 'stale overwrite', expectedFileIdentity: fileIdentity
    })).resolves.toMatchObject({ ok: false, caseId: 'write-file-identity-changed' })
    expect(await fs.readFile(target, 'utf8')).toBe('new content')
  })

  it('refuses to overwrite an existing target when the permit expected a new file', async () => {
    const root = await tempDir()
    const targetDir = path.join(root, 'target')
    await fs.mkdir(targetDir)
    const target = path.join(targetDir, 'existing.txt')
    await fs.writeFile(target, 'winner')
    const directory = await fs.stat(targetDir)
    await expect(writeFileAtomicallyBoundToDirectory({
      directory: targetDir,
      expectedDirectoryIdentity: { dev: directory.dev, ino: directory.ino, mode: directory.mode, size: directory.size, mtimeMs: directory.mtimeMs },
      targetName: 'existing.txt', body: 'loser', expectedFileIdentity: null
    })).resolves.toMatchObject({ ok: false, caseId: 'write-target-exists' })
    expect(await fs.readFile(target, 'utf8')).toBe('winner')
  })
})
