import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupMcpArtifacts } from './mcpArtifactCleanup'
import { beginMcpArtifactPublish, beginMcpArtifactSweep, completeMcpArtifactPublish, readMcpArtifactCapacity, setMcpArtifactCapacityRequest, settleMcpArtifactSweep } from './mcpArtifactCapacity'

describe('MCP artifact capacity generation', () => {
  const roots: string[] = []
  afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })
  async function root() { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-artifact-capacity-')); roots.push(value); return value }

  it('persists intent before publication and counts published bytes toward the capacity watermark', async () => {
    const dir = await root()
    await beginMcpArtifactPublish(dir, 'artifact-a', 200 * 1024 * 1024)
    expect(await readMcpArtifactCapacity(dir)).toMatchObject({ generation: 1, pending: ['artifact-a'], estimatedBytes: 0 })
    const result = await completeMcpArtifactPublish(dir, 'artifact-a')
    expect(result).toMatchObject({ generation: 2, pending: [], estimatedBytes: 200 * 1024 * 1024, overQuota: false })
    await beginMcpArtifactPublish(dir, 'artifact-b', 60 * 1024 * 1024)
    expect(await completeMcpArtifactPublish(dir, 'artifact-b')).toMatchObject({ generation: 4, estimatedBytes: 260 * 1024 * 1024, overQuota: true })
  })

  it('does not clear a newer generation when a sweep races with a published artifact', async () => {
    const dir = await root()
    await beginMcpArtifactPublish(dir, 'before', 1)
    await completeMcpArtifactPublish(dir, 'before')
    const generation = (await readMcpArtifactCapacity(dir)).generation
    await beginMcpArtifactSweep(dir)
    await beginMcpArtifactPublish(dir, 'during', 1)
    await completeMcpArtifactPublish(dir, 'during', 1)
    await expect(settleMcpArtifactSweep(dir, generation, 0)).resolves.toMatchObject({ dirty: true, generation: generation + 2 })
    await expect(settleMcpArtifactSweep(dir, generation + 2, 0)).resolves.toMatchObject({ dirty: false, generation: generation + 2, estimatedBytes: 0 })
  })

  it('keeps a pre-publication crash intent dirty so startup can rebuild its estimate', async () => {
    const dir = await root()
    await beginMcpArtifactPublish(dir, 'crashed-before-rename', 100)
    await expect(readMcpArtifactCapacity(dir)).resolves.toMatchObject({ dirty: true, pending: ['crashed-before-rename'] })
    await cleanupMcpArtifacts(dir)
    await expect(readMcpArtifactCapacity(dir)).resolves.toMatchObject({ dirty: false, pending: [], estimatedBytes: 0 })
  })

  it('rebuilds the estimate from a file left by a crash after publication', async () => {
    const dir = await root()
    await beginMcpArtifactPublish(dir, 'artifact-mcp-after-rename', 4)
    await fs.writeFile(path.join(dir, 'artifact-mcp-after-rename.log'), 'data')
    await cleanupMcpArtifacts(dir)
    await expect(readMcpArtifactCapacity(dir)).resolves.toMatchObject({ dirty: false, pending: [], estimatedBytes: 4 })
  })

  it('requests a quota sweep only after the published capacity exceeds the quota', async () => {
    const dir = await root()
    const request = vi.fn()
    setMcpArtifactCapacityRequest(request)
    try {
      await beginMcpArtifactPublish(dir, 'large-output', 257 * 1024 * 1024)
      expect(request).not.toHaveBeenCalled()
      await completeMcpArtifactPublish(dir, 'large-output')
      expect(request).toHaveBeenCalledTimes(1)
    } finally { setMcpArtifactCapacityRequest(undefined) }
  })

  it.each([
    ['directory open', 'EISDIR', 'open'],
    ['directory sync', 'EINVAL', 'sync']
  ])('allows capacity publish and sweep when %s is unsupported', async (_label, code, operation) => {
    const dir = await root()
    const originalOpen = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation((async (filePath: fs.PathLike, ...args: unknown[]) => {
      if (filePath === dir && operation === 'open') throw Object.assign(new Error('unsupported directory open'), { code })
      if (filePath === dir && operation === 'sync') return { sync: async () => { throw Object.assign(new Error('unsupported directory sync'), { code }) }, close: async () => undefined } as unknown as Awaited<ReturnType<typeof fs.open>>
      return (originalOpen as (...input: unknown[]) => Promise<Awaited<ReturnType<typeof fs.open>>>)(filePath, ...args)
    }) as typeof fs.open)
    await expect(beginMcpArtifactPublish(dir, 'supported-write', 12)).resolves.toBeUndefined()
    await expect(completeMcpArtifactPublish(dir, 'supported-write')).resolves.toMatchObject({ dirty: true, estimatedBytes: 12 })
    await expect(cleanupMcpArtifacts(dir)).resolves.toMatchObject({ success: true, scanned: 0, remainingBytes: 0 })
  })
})
