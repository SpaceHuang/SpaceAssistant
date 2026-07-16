import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { resolveSafeWriteTarget } from './pathSecurity'
import {
  SAFE_WRITE_TEMP_PREFIX,
  cleanupSafeWriteTemps,
  captureFileIdentity,
  safeAtomicWrite
} from './safeAtomicWrite'

describe('resolveSafeWriteTarget + safeAtomicWrite', () => {
  let workDir: string
  let outside: string

  beforeEach(async () => {
    workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-write-')))
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-out-')))
  })

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {})
  })

  it('creates a new file via link commit', async () => {
    const target = await resolveSafeWriteTarget(workDir, 'a/b/new.txt')
    expect(target.existed).toBe(false)
    await safeAtomicWrite({
      targetPath: target.targetPath,
      parentReal: target.parentReal,
      body: 'hello',
      expectedIdentity: null
    })
    expect(await fs.readFile(target.targetPath, 'utf8')).toBe('hello')
  })

  it('overwrites an existing file after identity check', async () => {
    const abs = path.join(workDir, 'exist.txt')
    await fs.writeFile(abs, 'old')
    const target = await resolveSafeWriteTarget(workDir, 'exist.txt')
    expect(target.existed).toBe(true)
    const id = await captureFileIdentity(abs)
    await safeAtomicWrite({
      targetPath: target.targetPath,
      parentReal: target.parentReal,
      body: 'new',
      expectedIdentity: id
    })
    expect(await fs.readFile(abs, 'utf8')).toBe('new')
  })

  it('rejects parent symlink escape', async () => {
    await fs.symlink(outside, path.join(workDir, 'symlink-outside'))
    await expect(resolveSafeWriteTarget(workDir, 'symlink-outside/new-file.txt')).rejects.toThrow(
      /符号链接/
    )
  })

  it('rejects target that is a symlink', async () => {
    const outsideFile = path.join(outside, 'secret.txt')
    await fs.writeFile(outsideFile, 'secret')
    await fs.symlink(outsideFile, path.join(workDir, 'link.txt'))
    await expect(resolveSafeWriteTarget(workDir, 'link.txt')).rejects.toThrow(/符号链接/)
  })

  it('rejects hard-linked target and leaves outside content intact', async () => {
    const outsideFile = path.join(outside, 'shared.txt')
    await fs.writeFile(outsideFile, 'keep-me')
    const inside = path.join(workDir, 'hard.txt')
    await fs.link(outsideFile, inside)
    await expect(resolveSafeWriteTarget(workDir, 'hard.txt')).rejects.toThrow(/硬链接/)
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('keep-me')
  })

  it('fails new-file commit when target was created first', async () => {
    const target = await resolveSafeWriteTarget(workDir, 'race.txt')
    await fs.writeFile(target.targetPath, 'winner')
    await expect(
      safeAtomicWrite({
        targetPath: target.targetPath,
        parentReal: target.parentReal,
        body: 'loser',
        expectedIdentity: null
      })
    ).rejects.toThrow(/已存在/)
    expect(await fs.readFile(target.targetPath, 'utf8')).toBe('winner')
  })

  it('fails overwrite when identity changed before commit', async () => {
    const abs = path.join(workDir, 'chg.txt')
    await fs.writeFile(abs, 'v1')
    const target = await resolveSafeWriteTarget(workDir, 'chg.txt')
    const id = await captureFileIdentity(abs)
    await fs.writeFile(abs, 'v2-external')
    await expect(
      safeAtomicWrite({
        targetPath: target.targetPath,
        parentReal: target.parentReal,
        body: 'v3',
        expectedIdentity: id
      })
    ).rejects.toThrow(/外部修改|替换/)
    expect(await fs.readFile(abs, 'utf8')).toBe('v2-external')
  })

  it('cleans temp on abort and leaves original intact', async () => {
    const abs = path.join(workDir, 'keep.txt')
    await fs.writeFile(abs, 'original')
    const target = await resolveSafeWriteTarget(workDir, 'keep.txt')
    const id = await captureFileIdentity(abs)
    const ac = new AbortController()
    ac.abort()
    await expect(
      safeAtomicWrite({
        targetPath: target.targetPath,
        parentReal: target.parentReal,
        body: 'should-not',
        expectedIdentity: id,
        signal: ac.signal
      })
    ).rejects.toThrow()
    expect(await fs.readFile(abs, 'utf8')).toBe('original')
    const entries = await fs.readdir(workDir)
    expect(entries.filter((e) => e.startsWith(SAFE_WRITE_TEMP_PREFIX))).toEqual([])
  })

  it('cleanupSafeWriteTemps removes leftover prefix files', async () => {
    const leftover = path.join(workDir, `${SAFE_WRITE_TEMP_PREFIX}deadbeef`)
    await fs.writeFile(leftover, 'orphan')
    await cleanupSafeWriteTemps(workDir)
    await expect(fs.access(leftover)).rejects.toThrow()
  })

  it('writeAllBytes loops until the full buffer is written', async () => {
    const { writeAllBytes } = await import('./safeAtomicWrite')
    const chunks: Buffer[] = []
    let call = 0
    const fh = {
      write: async (buf: Buffer, offset: number, length: number, _position: number) => {
        call += 1
        // First call writes only 2 bytes; subsequent calls write the rest.
        const n = call === 1 ? Math.min(2, length) : length
        chunks.push(Buffer.from(buf.subarray(offset, offset + n)))
        return { bytesWritten: n, buffer: buf }
      }
    }
    await writeAllBytes(fh as never, Buffer.from('abcdef'), 0)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('abcdef')
    expect(call).toBeGreaterThan(1)
  })
})
