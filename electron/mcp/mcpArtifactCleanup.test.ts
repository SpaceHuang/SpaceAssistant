import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { cleanupMcpArtifacts, cleanupMcpArtifactsOnStartup } from './mcpArtifactCleanup'

describe('cleanupMcpArtifactsOnStartup', () => {
  it('is safe when the MCP artifact directory does not exist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-artifact-startup-'))
    await expect(cleanupMcpArtifactsOnStartup(root)).resolves.toMatchObject({ success: true, scanned: 0 })
  })

  it('removes expired MCP files on startup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-artifact-startup-'))
    const dir = path.join(root, 'shell-output', 'mcp')
    await fs.mkdir(dir, { recursive: true })
    const old = path.join(dir, 'expired.log')
    await fs.writeFile(old, 'old')
    await fs.utimes(old, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), new Date(Date.now() - 8 * 24 * 60 * 60 * 1000))
    await cleanupMcpArtifactsOnStartup(root)
    await expect(fs.access(old)).rejects.toThrow()
  })

  it('uses one directory scan and at most one stat per artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-artifact-single-pass-'))
    const dir = path.join(root, 'shell-output', 'mcp')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'recent.log'), 'recent')
    const readdir = vi.spyOn(fs, 'readdir')
    const stat = vi.spyOn(fs, 'stat')
    await cleanupMcpArtifacts(dir)
    expect(readdir.mock.calls.filter(([target]) => target === dir)).toHaveLength(1)
    expect(stat.mock.calls.filter(([target]) => target === path.join(dir, 'recent.log'))).toHaveLength(1)
    readdir.mockRestore()
    stat.mockRestore()
  })

  it('propagates non-ENOENT directory enumeration failures', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const readdir = vi.spyOn(fs, 'readdir').mockRejectedValue(failure)
    await expect(cleanupMcpArtifacts('/tmp/mcp-cleanup-denied')).rejects.toMatchObject({ code: 'EACCES' })
    readdir.mockRestore()
  })

  it('does not hide stat and unlink failures or count failed quota removals as freed capacity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-artifact-failure-'))
    const dir = path.join(root, 'shell-output', 'mcp')
    await fs.mkdir(dir, { recursive: true })
    const artifact = path.join(dir, 'recent.log')
    await fs.writeFile(artifact, 'recent')
    const statFailure = Object.assign(new Error('stat denied'), { code: 'EACCES' })
    const stat = vi.spyOn(fs, 'stat').mockRejectedValueOnce(statFailure)
    await expect(cleanupMcpArtifacts(dir)).rejects.toMatchObject({ code: 'EACCES' })
    stat.mockRestore()

    const quotaFile = path.join(dir, 'large.bin')
    await fs.writeFile(quotaFile, '')
    await fs.truncate(quotaFile, 257 * 1024 * 1024)
    const unlinkFailure = Object.assign(new Error('unlink denied'), { code: 'EACCES' })
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(unlinkFailure)
    await expect(cleanupMcpArtifacts(dir)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(fs.stat(quotaFile)).resolves.toMatchObject({ size: 257 * 1024 * 1024 })
    unlink.mockRestore()
    await expect(cleanupMcpArtifacts(dir)).resolves.toMatchObject({ success: true })
  })
})
