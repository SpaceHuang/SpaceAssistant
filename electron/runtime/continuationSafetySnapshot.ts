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
  executionConfigFingerprint: string
}): ContinuationSafetySnapshot {
  if (!input.workDirProfileId.trim() || !input.workDir.trim() || !input.authorizationVersion.trim() || !/^[0-9a-f]{64}$/.test(input.executionConfigFingerprint)) {
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
    toolSetSha256: sha256(tools),
    executionConfigSha256: input.executionConfigFingerprint
  }
}

/** Hashes effective mutable tool routing/configuration without persisting any raw setting. */
export function fingerprintContinuationExecutionConfig(input: {
  toolsConfig: unknown
  browserConfig: unknown
  shellConfig: unknown
  mcpBackends: unknown
}): string {
  return sha256(input)
}

export function assertContinuationExecutionConfigUnchanged(expectedFingerprint: string | undefined, actualFingerprint: string): void {
  if (!expectedFingerprint || expectedFingerprint !== actualFingerprint) throw new Error('CONTINUATION_EXECUTION_CONFIG_CHANGED')
}
