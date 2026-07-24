import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { normalizeRelPathInput, resolveSafePath, resolveSafeWorkDirPath } from './pathSecurity'

describe('pathSecurity', () => {
  it('normalizeRelPathInput converts backslashes', () => {
    expect(normalizeRelPathInput('项目\\上传者\\草稿')).toBe('项目/上传者/草稿')
  })

  it('resolveSafePath accepts normalized relative paths on Windows', () => {
    const base = path.resolve('/fake/workdir')
    const resolved = resolveSafePath(base, '项目/上传者/草稿')
    expect(resolved).toBe(path.resolve(base, '项目/上传者/草稿'))
  })

  describe('resolveSafeWorkDirPath', () => {
    it('keeps absolute in-workdir paths without nesting under workDir again', async () => {
      const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-workdir-')))
      const target = path.join(workDir, 'docs', 'analyze')
      await fs.mkdir(target, { recursive: true })

      const resolved = await resolveSafeWorkDirPath(workDir, target)

      expect(resolved).toBe(target)
      expect(resolved).not.toContain(path.join(path.basename(workDir), path.basename(workDir)))
    })

    it('still resolves relative paths under workDir', async () => {
      const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-workdir-')))
      const target = path.join(workDir, 'docs', 'analyze')
      await fs.mkdir(target, { recursive: true })

      const resolved = await resolveSafeWorkDirPath(workDir, 'docs/analyze')

      expect(resolved).toBe(target)
    })

    it('rejects absolute paths outside workDir', async () => {
      const workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-workdir-')))
      const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-outside-')))

      await expect(resolveSafeWorkDirPath(workDir, outside)).rejects.toThrow('路径超出工作目录范围')
    })
  })
})
