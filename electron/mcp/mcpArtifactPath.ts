import path from 'path'
import { isValidMcpArtifactId } from '../../src/shared/mcpArtifactSecurity'

export function resolveMcpArtifactPath(userDataPath: string, artifactId: unknown): string | undefined {
  if (!isValidMcpArtifactId(artifactId)) return undefined
  return path.join(path.resolve(userDataPath), 'shell-output', 'mcp', `${artifactId}.log`)
}

export function resolveMcpArtifactOwnerPath(userDataPath: string, artifactId: unknown): string | undefined {
  const artifactPath = resolveMcpArtifactPath(userDataPath, artifactId)
  return artifactPath ? `${artifactPath}.owner.json` : undefined
}
