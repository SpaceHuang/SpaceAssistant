import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyFileWithHash, copyTreeWithManifest } from './streamingCopy'
import { StorageMaintenanceError } from './storageMaintenanceError'

describe('streamingCopy', () => {
  const roots: string[] = []
  const tempRoot = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streaming-copy-'))
    roots.push(dir)
    return dir
  }
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  async function writeRandomFile(filePath: string, size: number) {
    const handle = await fs.open(filePath, 'wx')
    try {
      let remaining = size
      while (remaining > 0) {
        const chunk = randomBytes(Math.min(remaining, 1024 * 1024))
        await handle.write(chunk)
        remaining -= chunk.length
      }
    } finally { await handle.close() }
  }

  async function sha256File(filePath: string): Promise<string> {
    const hash = createHash('sha256')
    const stream = fsSync.createReadStream(filePath)
    for await (const chunk of stream) hash.update(chunk as Buffer)
    return hash.digest('hex')
  }

  it('copies with 4MiB chunks and returns both hashes matching an independent full-file hash', async () => {
    const dir = await tempRoot()
    const source = path.join(dir, 'source.bin')
    const dest = path.join(dir, 'dest.bin')
    await writeRandomFile(source, 5 * 1024 * 1024)
    const expected = await sha256File(source)

    const result = await copyFileWithHash(source, dest)

    expect(result.bytes).toBe(5 * 1024 * 1024)
    expect(result.sourceSha256).toBe(expected)
    expect(result.destSha256).toBe(expected)
    expect(await sha256File(dest)).toBe(expected)
    await expect(copyFileWithHash(source, dest)).rejects.toThrow(/EEXIST/)
  })

  it('reports monotonic progress that ends at the copied byte count', async () => {
    const dir = await tempRoot()
    const source = path.join(dir, 'source.bin')
    const dest = path.join(dir, 'dest.bin')
    await writeRandomFile(source, 5 * 1024 * 1024)
    const seen: number[] = []

    const result = await copyFileWithHash(source, dest, { onProgress: (bytes) => seen.push(bytes) })

    expect(seen.length).toBeGreaterThan(0)
    for (let index = 1; index < seen.length; index += 1) expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]!)
    expect(seen.at(-1)).toBe(result.bytes)
  })

  it('throws STORAGE_MAINTENANCE_CANCELLED when aborted between chunks', async () => {
    const dir = await tempRoot()
    const source = path.join(dir, 'source.bin')
    const dest = path.join(dir, 'dest.bin')
    await writeRandomFile(source, 5 * 1024 * 1024)
    const controller = new AbortController()

    const failure = await copyFileWithHash(source, dest, {
      signal: controller.signal,
      onProgress: () => controller.abort()
    }).then(() => { throw new Error('expected an abort rejection') }, (error: unknown) => error)

    expect(failure).toBeInstanceOf(StorageMaintenanceError)
    expect((failure as StorageMaintenanceError).code).toBe('STORAGE_MAINTENANCE_CANCELLED')
  })

  it('detects injected destination corruption through the read-back hash', async () => {
    const dir = await tempRoot()
    const source = path.join(dir, 'source.bin')
    const dest = path.join(dir, 'dest.bin')
    await writeRandomFile(source, 9 * 1024 * 1024)
    const originalWriteSync = fsSync.writeSync
    let corrupted = false
    vi.spyOn(fsSync, 'writeSync').mockImplementation(((fd: number, buffer: Buffer) => {
      const written = originalWriteSync.call(fsSync, fd, buffer)
      if (!corrupted) {
        corrupted = true
        const handle = fsSync.openSync(dest, 'r+')
        try {
          const byte = Buffer.alloc(1)
          fsSync.readSync(handle, byte, 0, 1, 100)
          byte[0] ^= 0xff
          fsSync.writeSync(handle, byte, 0, 1, 100)
        } finally { fsSync.closeSync(handle) }
      }
      return written
    }) as typeof fsSync.writeSync)

    const result = await copyFileWithHash(source, dest)

    expect(result.bytes).toBe(9 * 1024 * 1024)
    expect(result.destSha256).not.toBe(result.sourceSha256)
    expect(await sha256File(dest)).toBe(result.destSha256)
  })

  it('copies a nested tree in one pass with sorted both-side manifests', async () => {
    const dir = await tempRoot()
    const sourceRoot = path.join(dir, 'spill')
    const destRoot = path.join(dir, 'archive-spill')
    await fs.mkdir(path.join(sourceRoot, 'nested'), { recursive: true })
    await writeRandomFile(path.join(sourceRoot, 'a.spill'), 300)
    await writeRandomFile(path.join(sourceRoot, 'nested', 'b.spill'), 700)

    const result = await copyTreeWithManifest(sourceRoot, destRoot)

    expect(result.bytes).toBe(1000)
    expect(result.sourceManifest).toEqual([
      `a.spill${'\0'}300${'\0'}${await sha256File(path.join(sourceRoot, 'a.spill'))}`,
      `nested/b.spill${'\0'}700${'\0'}${await sha256File(path.join(sourceRoot, 'nested', 'b.spill'))}`
    ])
    expect(result.destManifest).toEqual(result.sourceManifest)
    expect(await fs.readFile(path.join(destRoot, 'nested', 'b.spill'))).toEqual(await fs.readFile(path.join(sourceRoot, 'nested', 'b.spill')))
  })

  it('returns empty manifests for a missing or empty root without touching the destination', async () => {
    const dir = await tempRoot()
    const emptyResult = await copyTreeWithManifest(path.join(dir, 'empty'), path.join(dir, 'dest-empty'))
    expect(emptyResult).toEqual({ bytes: 0, sourceManifest: [], destManifest: [] })
    await expect(fs.stat(path.join(dir, 'dest-empty'))).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.mkdir(path.join(dir, 'present'))
    const presentResult = await copyTreeWithManifest(path.join(dir, 'present'), path.join(dir, 'dest-present'))
    expect(presentResult).toEqual({ bytes: 0, sourceManifest: [], destManifest: [] })
  })

  it('rejects a symbolic link inside the source tree', async () => {
    const dir = await tempRoot()
    const sourceRoot = path.join(dir, 'spill')
    await fs.mkdir(sourceRoot)
    await writeRandomFile(path.join(dir, 'target.bin'), 10)
    try {
      await fs.symlink(path.join(dir, 'target.bin'), path.join(sourceRoot, 'link.spill'), 'file')
    } catch { return /* 当前环境无符号链接权限时跳过该用例 */ }

    await expect(copyTreeWithManifest(sourceRoot, path.join(dir, 'dest'))).rejects.toThrow('archive spill tree contains a symbolic link')
  })

  it('reports tree progress as a cumulative sum across files', async () => {
    const dir = await tempRoot()
    const sourceRoot = path.join(dir, 'spill')
    await fs.mkdir(sourceRoot)
    await writeRandomFile(path.join(sourceRoot, 'a.spill'), 5 * 1024 * 1024)
    await writeRandomFile(path.join(sourceRoot, 'b.spill'), 3 * 1024 * 1024)
    const seen: number[] = []

    const result = await copyTreeWithManifest(sourceRoot, path.join(dir, 'dest'), { onProgress: (bytes) => seen.push(bytes) })

    expect(seen.at(-1)).toBe(result.bytes)
    expect(result.bytes).toBe(8 * 1024 * 1024)
    for (let index = 1; index < seen.length; index += 1) expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]!)
  })
})
