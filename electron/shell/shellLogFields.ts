import { createHash } from 'crypto'
import type { AgentLogEventName } from '../agentLogger/types'

const FINGERPRINT_KEYS = new Set(['command', 'code', 'input'])
const DROP_KEYS = new Set([
  'description',
  'cwd',
  'executable',
  'path',
  'persistedOutputPath',
  'stdoutPreview',
  'stderrPreview',
  'summary'
])
const ALLOWED_KEYS = new Set([
  'requestId', 'sessionId', 'toolUseId', 'loopRound',
  'invocationFingerprint', 'commandFingerprint', 'cwdFingerprint', 'environmentFingerprint', 'planDigest',
  'shell', 'shellId', 'pid', 'timeoutSec', 'ioMaxBytes', 'durationMs',
  'exitCode', 'signal', 'exitCodeHint', 'interrupted', 'timedOut', 'cancelled', 'truncated', 'success',
  'persistedOutput', 'artifactAvailable', 'outputArtifactBytes', 'outputArtifactSha256',
  'stdoutBytes', 'stderrBytes', 'stdoutSha256', 'stderrSha256', 'stdoutRedacted', 'stderrRedacted',
  'outputPersistErrorCode', 'terminationErrorCode', 'terminationSignal', 'treeKillVerified',
  'outputLimitReached', 'captureCaseId', 'progressCaseId', 'terminationCaseId',
  'caseId', 'convergenceCaseId', 'validatorId', 'denyType', 'userAction', 'violationCodes',
  'requiresRiskAck', 'outsideWorkDirRisk', 'warningsCount', 'scannedPathsCount', 'canTrust', 'skipConfirm',
  'outcome', 'retryCount', 'retryExhausted', 'status', 'terminationReason', 'redacted',
  'errorCode', 'reasonCode', 'errorRedacted', 'reasonRedacted'
])

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeFingerprint(value: unknown): string {
  try {
    return fingerprint(typeof value === 'string' ? value : JSON.stringify(value ?? null))
  } catch {
    return fingerprint('[unserializable]')
  }
}

export function shellInvocationFingerprint(command: string): string {
  return fingerprint(command)
}

function isStableCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{2,127}$/.test(value)
}

function addOutputMetadata(out: Record<string, unknown>, key: 'stdout' | 'stderr', value: unknown): void {
  if (typeof value !== 'string') return
  out[`${key}Bytes`] = Buffer.byteLength(value, 'utf8')
  out[`${key}Sha256`] = fingerprint(value)
  out[`${key}Redacted`] = true
}

/** Shell/Script 共用的 Agent 日志 allowlist；未知字段默认丢弃。 */
export function projectShellAgentLogFields(
  _event: AgentLogEventName,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'stdout' || key === 'stderr') {
      addOutputMetadata(out, key, value)
      continue
    }
    if (FINGERPRINT_KEYS.has(key)) {
      out[key === 'command' ? 'invocationFingerprint' : `${key}Fingerprint`] = safeFingerprint(value)
      continue
    }
    if (key === 'error' || key === 'spawnError') {
      if (isStableCode(value)) out.errorCode = value
      else out.errorRedacted = true
      continue
    }
    if (key === 'reason' || key === 'securityWarning') {
      if (isStableCode(value)) out.reasonCode = value
      else out.reasonRedacted = true
      continue
    }
    if (DROP_KEYS.has(key) || !ALLOWED_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}
