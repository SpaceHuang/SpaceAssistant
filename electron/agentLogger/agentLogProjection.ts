import { createHash } from 'crypto'
import type { AgentLogEventName } from './types'
import { projectProcessResultForAgentLog } from '../../src/shared/agentSafeProjection'
import { isProcessToolName, projectToolResultForSink } from '../../src/shared/processResultProjection'
import { projectShellAgentLogFields } from '../shell/shellLogFields'

const TARGET_EVENTS = new Set<AgentLogEventName>([
  'retention.spill.cleaned',
  'storage.spill.source_truth_gc', 'storage.spill.source_truth_gc_failed',
  'llm.silent_overflow',
  'llm.cancel', 'turn.cancel', 'turn.cancel.tools',
  'tool.request', 'tool.error', 'tool.result', 'tool.result.contract-violation',
  'trust.remove',
  'history.cutover', 'session.storage.shadow', 'session.history.recovery', 'session.history.repair.failed', 'session.transcript.read',
  'session.projection.build.slice', 'session.transcript.reconciliation', 'session.switch.trace',
  'tools.execution_summary',
  'shell.security.deny', 'shell.trust.command', 'shell.path.confirm', 'shell.path.reject', 'shell.precheck', 'shell.confirm',
  'shell.exec.start', 'shell.exec.plan_failed', 'shell.exec.spawned', 'shell.exec.auto_background',
  'shell.exec.background', 'shell.exec.finish', 'shell.exec.error', 'grep.terminate'
])
const RENDERER_SESSION_SWITCH_STAGES = new Set([
  'selection-to-page-request', 'renderer-page-request', 'failure-reason-hydration', 'store-commit', 'render-commit', 'next-paint'
])
const COMMON_KEYS = new Set([
  'requestId', 'sessionId', 'toolUseId', 'loopRound', 'toolName', 'level', 'success', 'durationMs',
  'inputFingerprint', 'invocationFingerprint', 'commandFingerprint', 'cwdFingerprint', 'environmentFingerprint',
  'model', 'llmServiceId', 'kind', 'inputTokens', 'contextWindow', 'stopReason',
  'planDigest', 'caseId', 'convergenceCaseId', 'errorCode', 'reasonCode', 'errorRedacted', 'reasonRedacted',
  'userAction', 'validatorId', 'denyType', 'violationCodes', 'requiresRiskAck', 'outsideWorkDirRisk',
  'warningsCount', 'scannedPathsCount', 'canTrust', 'skipConfirm', 'outcome', 'verdict', 'type', 'status', 'pid', 'shell',
  'shellId', 'exitCode', 'signal', 'exitCodeHint', 'interrupted', 'timedOut', 'cancelled', 'truncated', 'removed',
  'persistedOutput', 'artifactAvailable', 'outputArtifactBytes', 'outputArtifactSha256', 'stdoutBytes',
  'stderrBytes', 'stdoutSha256', 'stderrSha256', 'stdoutRedacted', 'stderrRedacted', 'outputPersistErrorCode',
  'terminationErrorCode', 'terminationSignal', 'treeKillVerified', 'outputLimitReached', 'captureCaseId',
  'progressCaseId', 'terminationCaseId', 'retryCount', 'retryExhausted', 'terminationReason', 'redacted',
  'reason', 'terminated', 'elapsedMs', 'terminationState', 'pendingRepairs',
  'dataBytes', 'dataSha256', 'outputTruncated', 'outputRedacted', 'invariants', 'violationCount',
  'turnId', 'stage', 'historyStreamId', 'previousTurnId', 'snapshotVersion', 'transcriptVersion', 'reconciledCount',
  'accepted', 'abortToCatchMs', 'cancelledTools',
  'consumer', 'source', 'differenceCount', 'fieldNames', 'legacyHash', 'canonicalHash', 'acceptedInputFingerprint',
  'nextSequence', 'yielded',
  'appVersion',
  'releasedUnstarted', 'markedUncertain', 'repairedCheckpoints', 'phase', 'pending', 'completed', 'sharedReference', 'failed',
  'proposalCount', 'executorEntryCount', 'knownFailureCount', 'unknownOutcomeCount', 'notDispatchedCount',
  'baselineScanCount', 'projectedCount'
])

/** Strictly decode the renderer console envelope before forwarding only safe scalars to AgentLogger. */
export function projectRendererSessionSwitchTraceMessage(message: string, authoritativeProcessId?: number): Record<string, unknown> | undefined {
  const prefix = '[session.switch.trace.renderer] '
  if (!message.startsWith(prefix)) return undefined
  let value: unknown
  try { value = JSON.parse(message.slice(prefix.length)) } catch { return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const processId = candidate.rendererProcessId ?? authoritativeProcessId
  const requestOrdinal = candidate.requestOrdinal
  const outcome = candidate.outcome
  const pageSize = candidate.pageSize
  if (candidate.event !== 'session.switch.trace' || candidate.instance !== 'renderer' ||
    (authoritativeProcessId !== undefined && candidate.rendererProcessId !== undefined && candidate.rendererProcessId !== authoritativeProcessId) ||
    !Number.isSafeInteger(processId) || Number(processId) < 0 || !Number.isSafeInteger(requestOrdinal) || Number(requestOrdinal) < 1 ||
    (outcome !== 'ok' && outcome !== 'error') || !Number.isSafeInteger(pageSize) || Number(pageSize) < 0 || Number(pageSize) > 200 ||
    !Array.isArray(candidate.stages) || candidate.stages.length > 20) return undefined
  const stages = candidate.stages.flatMap((stage) => {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return []
    const item = stage as Record<string, unknown>
    if (typeof item.name !== 'string' || !RENDERER_SESSION_SWITCH_STAGES.has(item.name) ||
      typeof item.durationMs !== 'number' || !Number.isFinite(item.durationMs) || item.durationMs < 0 || item.durationMs > 600_000 ||
      (item.outcome !== 'ok' && item.outcome !== 'error')) return []
    return [{ name: item.name, durationMs: Math.round(item.durationMs * 100) / 100, outcome: item.outcome }]
  })
  return { instance: 'renderer', traceId: `${processId}-${requestOrdinal}`, rendererProcessId: processId,
    requestOrdinal, outcome, pageSize, stages }
}

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
  // P0-D3 组 1：run_script 执行期事件与 shell.exec.* 共用同一 Shell/Script allowlist
  if (event.startsWith('script.exec.')) return projectShellAgentLogFields(event, fields)
  if (!TARGET_EVENTS.has(event)) return fields
  if (event === 'session.switch.trace') return projectSessionSwitchTraceFields(fields)

  const out: Record<string, unknown> = {}
  const processTool = isProcessToolName(typeof fields.toolName === 'string' ? fields.toolName : undefined)
  for (const [key, value] of Object.entries(fields)) {
    if (fields.kind === 'session-ledger-gate' && ['sessionId', 'invocationId', 'workDir', 'eventsPath'].includes(key)) continue
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

function projectSessionSwitchTraceFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (fields.instance === 'main' || fields.instance === 'renderer') out.instance = fields.instance
  if (typeof fields.traceId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(fields.traceId)) out.traceId = fields.traceId
  if (Number.isSafeInteger(fields.rendererProcessId) && Number(fields.rendererProcessId) >= 0) out.rendererProcessId = fields.rendererProcessId
  if (Number.isSafeInteger(fields.requestOrdinal) && Number(fields.requestOrdinal) >= 1) out.requestOrdinal = fields.requestOrdinal
  if (['ok', 'error', 'cancelled', 'timeout'].includes(String(fields.outcome))) out.outcome = fields.outcome
  if (['ready', 'prior-authority', 'cold', 'invalidated', 'unknown'].includes(String(fields.cachePath))) out.cachePath = fields.cachePath
  if (Number.isSafeInteger(fields.pageSize) && Number(fields.pageSize) >= 0 && Number(fields.pageSize) <= 200) out.pageSize = fields.pageSize
  if (typeof fields.durationMs === 'number' && Number.isFinite(fields.durationMs) && fields.durationMs >= 0) out.durationMs = fields.durationMs
  if (Array.isArray(fields.stages) && fields.stages.length <= 20) {
    const stages = fields.stages.flatMap((stage) => {
      if (!stage || typeof stage !== 'object') return []
      const value = stage as Record<string, unknown>
      if (typeof value.name !== 'string' || !/^[a-z][a-z-]{0,47}$/.test(value.name) ||
        typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
        (value.outcome !== 'ok' && value.outcome !== 'error')) return []
      return [{ name: value.name, durationMs: value.durationMs, outcome: value.outcome }]
    })
    out.stages = stages
  }
  return out
}
