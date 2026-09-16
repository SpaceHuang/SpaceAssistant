import path from 'path'
import fs from 'fs/promises'
import { cleanupExpiredOutputArtifacts } from '../shell/outputArtifactCleanup'

const MCP_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MCP_ARTIFACT_QUOTA_BYTES = 256 * 1024 * 1024

export async function cleanupMcpArtifacts(directory: string, now = Date.now()): Promise<void> {
  await cleanupExpiredOutputArtifacts(directory, MCP_ARTIFACT_TTL_MS, now)
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = (await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(directory, entry.name)
    const stat = await fs.stat(filePath).catch(() => undefined)
    return stat ? { filePath, size: stat.size, mtimeMs: stat.mtimeMs } : undefined
  }))).filter((file): file is { filePath: string; size: number; mtimeMs: number } => Boolean(file)).sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = files.reduce((sum, file) => sum + file.size, 0)
  for (const file of files) {
    if (total <= MCP_ARTIFACT_QUOTA_BYTES) break
    await fs.unlink(file.filePath).catch(() => undefined)
    total -= file.size
  }
}

export async function cleanupMcpArtifactsOnStartup(userDataPath: string): Promise<void> {
  const directory = path.join(userDataPath, 'shell-output', 'mcp')
  const result = await cleanupExpiredOutputArtifacts(directory, MCP_ARTIFACT_TTL_MS)
  await cleanupMcpArtifacts(directory)
  if (result.failed > 0) console.warn('[mcp] artifact cleanup had failures', result)
}
