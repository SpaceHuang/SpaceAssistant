import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import vm from 'node:vm'
import { resolveSafeWriteTarget } from './pathSecurity'
import {
  SAFE_WRITE_TEMP_PREFIX,
  SafeAtomicWriteUncertainError,
  cleanupSafeWriteTemps,
  captureFileIdentity,
  safeAtomicWrite,
  verifyReviewFileReceipt
} from './safeAtomicWrite'
import * as directoryHandleWriterModule from './confirmation/directoryHandleWriter'
import { DIRECTORY_WRITER_SOURCE } from './confirmation/directoryHandleWriter'

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

  it('returns a content and open-handle receipt only when explicitly requested', async () => {
    const target = await resolveSafeWriteTarget(workDir, 'receipt.txt')
    const result = await safeAtomicWrite({ targetPath: target.targetPath, parentReal: target.parentReal,
      body: 'receipt body', expectedIdentity: null, captureReceipt: true })
    expect(result.receipt).toMatchObject({ size: 12, nlink: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const written = await fs.stat(target.targetPath)
    expect(result.receipt).toMatchObject({ dev: written.dev, ino: written.ino })
    expect(await verifyReviewFileReceipt(target.targetPath, result.receipt!)).toBe(true)
    await fs.writeFile(target.targetPath, 'changed')
    expect(await verifyReviewFileReceipt(target.targetPath, result.receipt!)).toBe(false)
  })

  it('rejects a same-length in-place rewrite immediately after the atomic commit', async () => {
    const target = await resolveSafeWriteTarget(workDir, 'race-receipt.txt')
    const payload = JSON.stringify({ directory: workDir,
      expectedDirectoryIdentity: (() => { const { dev, ino, mode, size, mtimeMs } = require('fs').statSync(workDir); return { dev, ino, mode, size, mtimeMs } })(),
      targetName: 'race-receipt.txt', tempName: '.sa-wtmp-race', bodyBase64: Buffer.from('approved').toString('base64'),
      expectedFileIdentity: null, mode: 0o600, captureReceipt: true })
    const realFs = require('fs') as typeof import('fs')
    const injectedFs = Object.create(realFs) as typeof import('fs')
    injectedFs.readFileSync = ((file: unknown, ...args: unknown[]) => file === 0 ? payload : realFs.readFileSync(file as never, ...(args as never[]))) as typeof realFs.readFileSync
    const localPath = (value: string) => path.isAbsolute(value) ? value : path.join(workDir, value)
    injectedFs.statSync = ((value: string, ...args: unknown[]) => realFs.statSync(localPath(value), ...(args as never[]))) as typeof realFs.statSync
    injectedFs.lstatSync = ((value: string, ...args: unknown[]) => realFs.lstatSync(localPath(value), ...(args as never[]))) as typeof realFs.lstatSync
    injectedFs.openSync = ((value: string, ...args: unknown[]) => realFs.openSync(localPath(value), ...(args as never[]))) as typeof realFs.openSync
    injectedFs.unlinkSync = ((value: string) => realFs.unlinkSync(localPath(value))) as typeof realFs.unlinkSync
    const link = realFs.linkSync.bind(realFs)
    injectedFs.linkSync = ((from: string, to: string) => {
      link(localPath(from), localPath(to))
      realFs.writeFileSync(path.join(workDir, to), 'tampered')
    }) as typeof realFs.linkSync
    let output = ''
    const fakeProcess = { stdout: { write: (text: string) => { output += text } }, exit: () => { throw new Error('worker-exit') } }
    try {
      vm.runInNewContext(DIRECTORY_WRITER_SOURCE, { require: (name: string) => name === 'node:fs' ? injectedFs : require(name), process: fakeProcess,
        Buffer, Atomics, Int32Array, SharedArrayBuffer, JSON, Error })
    } catch (error) {
      if ((error as Error).message !== 'worker-exit') throw error
    }
    const firstResultEnd = output.indexOf('}{') + 1
    expect(JSON.parse(firstResultEnd > 0 ? output.slice(0, firstResultEnd) : output))
      .toMatchObject({ ok: false, caseId: 'write-committed-receipt-invalid' })
    expect(await fs.readFile(target.targetPath, 'utf8')).toBe('tampered')
  })

  it.each(['linkSync', 'renameSync'] as const)('preserves uncertain status when post-commit readback sees truncation after %s', async (commitMethod) => {
    const targetPath = path.join(workDir, `truncated-${commitMethod}.txt`)
    if (commitMethod === 'renameSync') await fs.writeFile(targetPath, 'prior')
    const expectedFileIdentity = commitMethod === 'renameSync' ? (() => {
      const st = require('fs').statSync(targetPath)
      return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink }
    })() : null
    const parent = require('fs').statSync(workDir)
    const payload = JSON.stringify({ directory: workDir,
      expectedDirectoryIdentity: { dev: parent.dev, ino: parent.ino, mode: parent.mode, size: parent.size, mtimeMs: parent.mtimeMs },
      targetName: path.basename(targetPath), tempName: `.sa-wtmp-truncated-${commitMethod}`, bodyBase64: Buffer.from('approved').toString('base64'),
      expectedFileIdentity, mode: 0o600, captureReceipt: true })
    const realFs = require('fs') as typeof import('fs')
    const injectedFs = Object.create(realFs) as typeof import('fs')
    const localPath = (value: string) => path.isAbsolute(value) ? value : path.join(workDir, value)
    injectedFs.readFileSync = ((file: unknown, ...args: unknown[]) => file === 0 ? payload : realFs.readFileSync(localPath(file as string), ...(args as never[]))) as typeof realFs.readFileSync
    injectedFs.statSync = ((value: string, ...args: unknown[]) => realFs.statSync(localPath(value), ...(args as never[]))) as typeof realFs.statSync
    injectedFs.lstatSync = ((value: string, ...args: unknown[]) => realFs.lstatSync(localPath(value), ...(args as never[]))) as typeof realFs.lstatSync
    injectedFs.openSync = ((value: string, ...args: unknown[]) => realFs.openSync(localPath(value), ...(args as never[]))) as typeof realFs.openSync
    injectedFs.unlinkSync = ((value: string) => realFs.unlinkSync(localPath(value))) as typeof realFs.unlinkSync
    const originalCommit = realFs[commitMethod].bind(realFs) as (from: string, to: string) => void
    injectedFs[commitMethod] = ((from: string, to: string) => {
      originalCommit(localPath(from), localPath(to))
      realFs.truncateSync(localPath(to), 0)
    }) as typeof realFs[typeof commitMethod]
    let output = ''
    const fakeProcess = { stdout: { write: (text: string) => { output += text } }, exit: () => { throw new Error('worker-exit') } }
    try {
      vm.runInNewContext(DIRECTORY_WRITER_SOURCE, { require: (name: string) => name === 'node:fs' ? injectedFs : require(name), process: fakeProcess,
        Buffer, Atomics, Int32Array, SharedArrayBuffer, JSON, Error })
    } catch (error) {
      if ((error as Error).message !== 'worker-exit') throw error
    }
    const firstResultEnd = output.indexOf('}{') + 1
    expect(JSON.parse(firstResultEnd > 0 ? output.slice(0, firstResultEnd) : output))
      .toMatchObject({ ok: false, caseId: 'write-committed-receipt-invalid' })
    expect(await fs.readFile(targetPath, 'utf8')).toBe('')
  })

  it('maps a committed receipt failure to SafeAtomicWriteUncertainError', async () => {
    const worker = vi.spyOn(directoryHandleWriterModule, 'writeFileAtomicallyBoundToDirectory').mockResolvedValue({
      ok: false, caseId: 'write-committed-receipt-invalid'
    })
    try {
      await expect(safeAtomicWrite({ targetPath: path.join(workDir, 'uncertain.txt'), parentReal: workDir,
        body: 'approved', expectedIdentity: null, captureReceipt: true })).rejects.toBeInstanceOf(SafeAtomicWriteUncertainError)
    } finally { worker.mockRestore() }
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

  it('rejects parent symlink escape', async (ctx) => {
    try {
      await fs.symlink(outside, path.join(workDir, 'symlink-outside'))
    } catch (error) {
      // Windows 无开发者模式/权限时无法创建符号链接，属环境限制，跳过而非失败。
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw error
    }
    await expect(resolveSafeWriteTarget(workDir, 'symlink-outside/new-file.txt')).rejects.toThrow(
      /符号链接/
    )
  })

  it('rejects target that is a symlink', async (ctx) => {
    const outsideFile = path.join(outside, 'secret.txt')
    await fs.writeFile(outsideFile, 'secret')
    try {
      await fs.symlink(outsideFile, path.join(workDir, 'link.txt'))
    } catch (error) {
      // Windows 无开发者模式/权限时无法创建符号链接，属环境限制，跳过而非失败。
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw error
    }
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

  it.skipIf(process.platform === 'win32')('checks the permit-bound parent identity before cleaning temp files through a replaced symlink', async () => {
    const parent = path.join(workDir, 'permitted-parent')
    const victim = path.join(outside, `${SAFE_WRITE_TEMP_PREFIX}external-victim`)
    await fs.mkdir(parent)
    await fs.writeFile(victim, 'outside data')
    const identity = await fs.stat(parent)
    await fs.rmdir(parent)
    await fs.symlink(outside, parent, 'dir')

    await expect(safeAtomicWrite({
      targetPath: path.join(parent, 'new.txt'),
      parentReal: parent,
      body: 'blocked',
      expectedIdentity: null,
      expectedParentIdentity: { dev: identity.dev, ino: identity.ino, mode: identity.mode }
    })).rejects.toThrow()
    expect(await fs.readFile(victim, 'utf8')).toBe('outside data')
  })

  it.skipIf(process.platform === 'win32')('refuses to clean temp files when the cleanup directory itself is a symlink', async () => {
    const victim = path.join(outside, `${SAFE_WRITE_TEMP_PREFIX}cleanup-victim`)
    await fs.writeFile(victim, 'keep')
    const linked = path.join(workDir, 'cleanup-link')
    await fs.symlink(outside, linked, 'dir')
    await cleanupSafeWriteTemps(linked)
    expect(await fs.readFile(victim, 'utf8')).toBe('keep')
  })

  it.skipIf(process.platform === 'win32')('binds cleanup to the captured directory identity before unlinking temp files', async () => {
    const parent = path.join(workDir, 'cleanup-race')
    const victim = path.join(outside, `${SAFE_WRITE_TEMP_PREFIX}cleanup-race-victim`)
    await fs.mkdir(parent)
    await fs.writeFile(path.join(parent, `${SAFE_WRITE_TEMP_PREFIX}local-orphan`), 'local orphan')
    await fs.writeFile(victim, 'keep')
    const actualCleanup = directoryHandleWriterModule.cleanupDirectoryTempsBoundToIdentity
    const cleanup = vi.spyOn(directoryHandleWriterModule, 'cleanupDirectoryTempsBoundToIdentity').mockImplementation(async (input) => {
      await fs.rename(parent, `${parent}-moved`)
      await fs.symlink(outside, parent, 'dir')
      return actualCleanup(input)
    })
    try {
      await cleanupSafeWriteTemps(parent)
      expect(await fs.readFile(victim, 'utf8')).toBe('keep')
      expect(await fs.readFile(path.join(`${parent}-moved`, `${SAFE_WRITE_TEMP_PREFIX}local-orphan`), 'utf8')).toBe('local orphan')
    } finally {
      cleanup.mockRestore()
    }
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

  it('原子写 worker 已启动但取消导致提交结果丢失时返回不确定异常', async () => {
    const target = await resolveSafeWriteTarget(workDir, 'worker-cancelled.txt')
    const worker = vi.spyOn(directoryHandleWriterModule, 'writeFileAtomicallyBoundToDirectory')
      .mockResolvedValue({ ok: false, caseId: 'write-directory-cancelled' })

    await expect(safeAtomicWrite({
      targetPath: target.targetPath,
      parentReal: target.parentReal,
      body: 'possibly committed',
      expectedIdentity: null,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ name: 'SafeAtomicWriteUncertainError' })

    expect(worker).toHaveBeenCalledOnce()
    worker.mockRestore()
  })

  it.skipIf(process.platform === 'win32')('commit succeeds before permit-bound parent identity drifts, so outcome is reported as uncertain', async () => {
    const target = await resolveSafeWriteTarget(workDir, 'post-commit-drift.txt')
    const parent = await fs.stat(workDir)
    const moved = `${workDir}-moved`
    const actualWrite = directoryHandleWriterModule.writeFileAtomicallyBoundToDirectory
    const worker = vi.spyOn(directoryHandleWriterModule, 'writeFileAtomicallyBoundToDirectory').mockImplementation(async (input) => {
      const committed = await actualWrite(input)
      await fs.rename(workDir, moved)
      await fs.symlink(outside, workDir, 'dir')
      return committed
    })

    try {
      await expect(safeAtomicWrite({
        targetPath: target.targetPath,
        parentReal: target.parentReal,
        body: 'committed in the original directory',
        expectedIdentity: null,
        expectedParentIdentity: { dev: parent.dev, ino: parent.ino, mode: parent.mode }
      })).rejects.toMatchObject({ name: 'SafeAtomicWriteUncertainError' })
      expect(await fs.readFile(path.join(moved, 'post-commit-drift.txt'), 'utf8')).toBe('committed in the original directory')
    } finally {
      worker.mockRestore()
      await fs.rm(workDir, { recursive: true, force: true })
      workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-write-cleanup-')))
      await fs.rm(moved, { recursive: true, force: true })
    }
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
