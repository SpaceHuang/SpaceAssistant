import path from 'path'
import fs from 'fs/promises'
import { isErrno } from '../shell/outputArtifactCleanup'
import { beginMcpArtifactSweep, MCP_ARTIFACT_QUOTA_BYTES, settleMcpArtifactSweep } from './mcpArtifactCapacity'

const MCP_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000
type McpArtifact = { filePath: string; size: number; mtimeMs: number }
export type McpArtifactCleanupResult = Readonly<{
  success: true
  scanned: number
  ttlRemoved: number
  quotaRemoved: number
  remainingBytes: number
}>

export async function cleanupMcpArtifacts(directory: string, now = Date.now()): Promise<McpArtifactCleanupResult> {
  const generation = await beginMcpArtifactSweep(directory)
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) }
  catch (error) {
    if (isErrno(error, 'ENOENT')) {
      await settleMcpArtifactSweep(directory, generation, 0)
      return { success: true, scanned: 0, ttlRemoved: 0, quotaRemoved: 0, remainingBytes: 0 }
    }
    throw error
  }
  const files: McpArtifact[] = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '.mcp-artifact-capacity.json' || entry.name.endsWith('.tmp')) continue
    const filePath = path.join(directory, entry.name)
    let stat
    try { stat = await fs.stat(filePath) }
    catch (error) { if (isErrno(error, 'ENOENT')) continue; throw error }
    files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs })
  }

  let remaining = files
  let remainingBytes = files.reduce((sum, file) => sum + file.size, 0)
  let ttlRemoved = 0
  for (const file of files) {
    if (now - file.mtimeMs <= MCP_ARTIFACT_TTL_MS) continue
    try {
      await fs.unlink(file.filePath)
      ttlRemoved += 1
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    remaining = remaining.filter((candidate) => candidate.filePath !== file.filePath)
    remainingBytes -= file.size
  }

  let quotaRemoved = 0
  for (const file of [...remaining].sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (remainingBytes <= MCP_ARTIFACT_QUOTA_BYTES) break
    try {
      await fs.unlink(file.filePath)
      quotaRemoved += 1
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    remainingBytes -= file.size
    remaining = remaining.filter((candidate) => candidate.filePath !== file.filePath)
  }
  await settleMcpArtifactSweep(directory, generation, remainingBytes)
  return { success: true, scanned: files.length, ttlRemoved, quotaRemoved, remainingBytes }
}

export async function cleanupMcpArtifactsOnStartup(userDataPath: string): Promise<McpArtifactCleanupResult> {
  const directory = path.join(userDataPath, 'shell-output', 'mcp')
  const result = await cleanupMcpArtifacts(directory)
  if (result.ttlRemoved || result.quotaRemoved) console.info('[mcp] artifact cleanup completed', result)
  return result
}
