import { createHash } from 'node:crypto'
import type { ContinuationSafetySnapshot } from '../../src/shared/assistantFactAggregator'

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Build a non-sensitive fingerprint of the execution boundary accepted by a Turn. */
export function createContinuationSafetySnapshot(input: {
  workDirProfileId: string
  workDir: string
  authorizationVersion: string
  tools: readonly Readonly<{ name: string; inputSchema: unknown }>[]
}): ContinuationSafetySnapshot {
  if (!input.workDirProfileId.trim() || !input.workDir.trim() || !input.authorizationVersion.trim()) {
    throw new Error('CONTINUATION_SAFETY_SNAPSHOT_INCOMPLETE')
  }
  const tools = [...input.tools].map(({ name, inputSchema }) => ({ name, inputSchema }))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (tools.some(({ name }) => !name.trim()) || new Set(tools.map(({ name }) => name)).size !== tools.length) {
    throw new Error('CONTINUATION_TOOL_SNAPSHOT_INVALID')
  }
  return {
    workDirProfileId: input.workDirProfileId,
    workDirSha256: sha256(input.workDir),
    authorizationVersion: input.authorizationVersion,
    toolSetSha256: sha256(tools)
  }
}
