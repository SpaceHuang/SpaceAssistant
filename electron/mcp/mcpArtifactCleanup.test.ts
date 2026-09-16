import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { cleanupMcpArtifactsOnStartup } from './mcpArtifactCleanup'

describe('cleanupMcpArtifactsOnStartup', () => {
  it('is safe when the MCP artifact directory does not exist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-artifact-startup-'))
    await expect(cleanupMcpArtifactsOnStartup(root)).resolves.toBeUndefined()
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
})
