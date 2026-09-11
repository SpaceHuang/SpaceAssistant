import { createHash } from 'crypto'
import type { AgentLogEventName } from './types'
import { projectProcessResultForAgentLog } from '../../src/shared/agentSafeProjection'
import { isProcessToolName, projectToolResultForSink } from '../../src/shared/processResultProjection'
import { projectShellAgentLogFields } from '../shell/shellLogFields'

const TARGET_EVENTS = new Set<AgentLogEventName>([
  'tool.request', 'tool.error', 'tool.result',
  'trust.remove',
  'shell.security.deny', 'shell.trust.command', 'shell.path.confirm', 'shell.path.reject', 'shell.precheck', 'shell.confirm',
  'shell.exec.start', 'shell.exec.plan_failed', 'shell.exec.spawned', 'shell.exec.auto_background',
  'shell.exec.background', 'shell.exec.finish', 'shell.exec.error'
])
const COMMON_KEYS = new Set([
  'requestId', 'sessionId', 'toolUseId', 'loopRound', 'toolName', 'level', 'success', 'durationMs',
  'inputFingerprint', 'invocationFingerprint', 'commandFingerprint', 'cwdFingerprint', 'environmentFingerprint',
  'planDigest', 'caseId', 'convergenceCaseId', 'errorCode', 'reasonCode', 'errorRedacted', 'reasonRedacted',
  'userAction', 'validatorId', 'denyType', 'violationCodes', 'requiresRiskAck', 'outsideWorkDirRisk',
  'warningsCount', 'scannedPathsCount', 'canTrust', 'skipConfirm', 'outcome', 'verdict', 'type', 'status', 'pid', 'shell',
  'shellId', 'exitCode', 'signal', 'exitCodeHint', 'interrupted', 'timedOut', 'cancelled', 'truncated',
  'persistedOutput', 'artifactAvailable', 'outputArtifactBytes', 'outputArtifactSha256', 'stdoutBytes',
  'stderrBytes', 'stdoutSha256', 'stderrSha256', 'stdoutRedacted', 'stderrRedacted', 'outputPersistErrorCode',
  'terminationErrorCode', 'terminationSignal', 'treeKillVerified', 'outputLimitReached', 'captureCaseId',
  'progressCaseId', 'terminationCaseId', 'retryCount', 'retryExhausted', 'terminationReason', 'redacted',
  'dataBytes', 'dataSha256', 'outputTruncated', 'outputRedacted'
])

function hash(value: unknown): string {
  let serialized = 'null'
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  } catch {
    serialized = '[unserializable]'
  }
  return createHash('sha256').update(serialized).digest('hex')
}

function isStableCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{2,127}$/.test(value)
}

/** Agent logger 的第二道边界；目标事件只允许结构化 allowlist 字段。 */
export function projectAgentLogFields(
  event: AgentLogEventName,
  fields: Record<string, unknown>
): Record<string, unknown> {
  if (event.startsWith('shell.')) return projectShellAgentLogFields(event, fields)
  if (!TARGET_EVENTS.has(event)) return fields

  const out: Record<string, unknown> = {}
  const processTool = isProcessToolName(typeof fields.toolName === 'string' ? fields.toolName : undefined)
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'command' || key === 'code' || key === 'input') {
      out.inputFingerprint ??= hash(value)
      continue
    }
    if (event === 'trust.remove' && key === 'item') {
      out.itemFingerprint = hash(value)
      continue
    }
    if (key === 'stdout' || key === 'stderr') {
      out[`${key}Bytes`] = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0
      out[`${key}Sha256`] = hash(value)
      out[`${key}Redacted`] = true
      continue
    }
    if (key === 'data') {
      if (processTool) {
        Object.assign(out, projectProcessResultForAgentLog(value, { fingerprint: (text) => hash(text) }))
      } else {
        out.data = projectToolResultForSink({ success: true, data: value }, 'agent', { maxOutputChars: 32 * 1024 }).data
      }
      continue
    }
    if (key === 'error' || key === 'spawnError') {
      if (isStableCode(value)) out.errorCode = value
      else out.errorRedacted = true
      continue
    }
    if (key === 'userError' || key === 'userMessage' || key === 'summary') continue
    if (COMMON_KEYS.has(key)) out[key] = value
  }
  return out
}
