import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { cleanupExpiredOutputArtifacts } from './outputArtifactCleanup'

describe('cleanupExpiredOutputArtifacts', () => {
  it('删除过期文件、保留新文件并忽略子目录', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-cleanup-'))
    const oldFile = path.join(dir, 'old.log')
    const newFile = path.join(dir, 'new.log')
    await fs.writeFile(oldFile, 'old')
    await fs.writeFile(newFile, 'new')
    await fs.mkdir(path.join(dir, 'nested'))
    const now = Date.now()
    await fs.utimes(oldFile, new Date(now - 10_000), new Date(now - 10_000))
    const result = await cleanupExpiredOutputArtifacts(dir, 5_000, now)
    expect(result).toEqual({ removed: 1, failed: 0 })
    await expect(fs.access(oldFile)).rejects.toThrow()
    await expect(fs.access(newFile)).resolves.toBeUndefined()
    await expect(fs.access(path.join(dir, 'nested'))).resolves.toBeUndefined()
  })

  it('目录不存在时安全返回空结果', async () => {
    const result = await cleanupExpiredOutputArtifacts(path.join(os.tmpdir(), 'missing-shell-output'), 1)
    expect(result).toEqual({ removed: 0, failed: 0 })
  })
})
