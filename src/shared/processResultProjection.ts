import { sanitizeAgentText } from './agentSafeText'

export type ProcessProjectionSink = 'agent' | 'local_history' | 'telemetry'
export type PathScope = 'workspace' | 'system' | 'external' | 'unknown'

export interface ProcessProjectionOptions {
  /** 当前工具调用获得授权的 workspace；未提供时不会把未知绝对路径当成 workspace。 */
  workspaceRoot?: string
  /** 测试或 Electron 主进程可注入密码学指纹实现。 */
  fingerprint?: (value: string) => string
  /** Agent/history 单个 stdout/stderr 字段的上限；telemetry 永远不输出原文。 */
  maxOutputChars?: number
  /** 只有显式标记为进程工具时，才启用进程结果字段白名单和终态校验。 */
  processTool?: boolean
}

export interface ProjectableToolResult {
  success: boolean
  data?: unknown
  error?: string
  userMessage?: string
  diagnostic?: unknown
}

export interface ProjectedTelemetryResult {
  ok: boolean
  errorCode?: string
  diagnostic?: Record<string, unknown>
  data?: Record<string, unknown> | null
}

const STABLE_CODE_RE = /^[A-Z][A-Z0-9_.-]{2,127}$/
const SAFE_STATUS = new Set(['succeeded', 'failed', 'spawn_failed', 'signalled', 'timed_out', 'cancelled', 'output_limited', 'result_invalid'])
const SAFE_TERMINATION_REASONS = new Set(['process_exit', 'external_signal', 'timeout', 'user_cancel', 'output_limit', 'spawn_error', 'result_invalid'])
const SAFE_SIGNAL_RE = /^SIG[A-Z0-9]+$/
const SAFE_HASH_RE = /^[0-9a-f]{32,128}$/i
const SECRET_KEY_RE = /(?:key|token|secret|cookie|password|passwd)/i
const PROCESS_KEYS = new Set([
  'status', 'code', 'errorCode', 'caseId', 'exitCode', 'signal', 'terminationReason', 'interrupted',
  'timedOut', 'cancelled', 'truncated', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes',
  'stdoutSha256', 'stderrSha256', 'stdoutRedaction', 'stderrRedaction', 'outputArtifactBytes',
  'outputArtifactSha256', 'outputPersistErrorCode', 'terminationErrorCode', 'terminationSignal',
  'treeKillVerified', 'outputLimitReached', 'captureCaseId', 'progressCaseId', 'terminationCaseId',
  'artifactId', 'persistedOutputPath', 'shell', 'planDigest', 'retryCount', 'retryExhausted',
  'processResult', 'cwd', 'executable', 'durationMs', 'artifactAvailable', 'redacted'
])
const DIAGNOSTIC_KEYS = new Set(['caseId', 'retryable', 'category', 'code', 'phase', 'attempt'])

function defaultFingerprint(value: string): string {
  // 仅作为 shared 层的确定性 fallback；Electron telemetry 会注入 SHA-256 实现。
  // 这里不把结果当作秘密值的保护边界，秘密在进入本函数前已被丢弃。
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `opaque-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function fingerprint(value: string, options: ProcessProjectionOptions): string {
  return (options.fingerprint ?? defaultFingerprint)(value)
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/')
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith('/') || value.startsWith('//')
}

function isWithinRoot(value: string, root: string): boolean {
  const path = normalizePath(value).replace(/\/+$/, '')
  const base = normalizePath(root).replace(/\/+$/, '')
  if (!path || !base) return false
  const left = /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
  const right = /^[A-Za-z]:\//.test(base) ? base.toLowerCase() : base
  return left === right || left.startsWith(`${right}/`)
}

function isSystemPath(value: string): boolean {
  const path = normalizePath(value)
  return /^(?:[A-Za-z]:\/Windows(?:\/|$)|[A-Za-z]:\/Program Files(?: \(x86\))?(?:\/|$)|\/(?:usr|bin|sbin|lib|lib64|etc)(?:\/|$))/i.test(path)
}

function classifyPath(value: string, options: ProcessProjectionOptions): PathScope {
  const path = normalizePath(value)
  if (!isAbsolutePath(path)) return 'unknown'
  if (options.workspaceRoot && isWithinRoot(path, options.workspaceRoot)) return 'workspace'
  if (isSystemPath(path)) return 'system'
  return 'external'
}

function basename(value: string): string {
  const path = normalizePath(value).replace(/\/+$/, '')
  return path.slice(path.lastIndexOf('/') + 1) || 'unknown'
}

function artifactIdForPersistedPath(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  return /^[0-9a-f]{64}\.log$/i.test(name) ? `artifact-${name.slice(0, -4)}` : 'artifact-redacted'
}

function relativeToWorkspace(value: string, workspaceRoot: string): string {
  const path = normalizePath(value).replace(/\/+$/, '')
  const root = normalizePath(workspaceRoot).replace(/\/+$/, '')
  if (path === root) return '.'
  return path.slice(root.length + 1) || '.'
}

function isPathLikeData(value: Record<string, unknown>): boolean {
  return 'processResult' in value || 'stdout' in value || 'stderr' in value ||
    'status' in value || 'cwd' in value || 'executable' in value
}

export const PROCESS_TOOL_NAMES = new Set(['run_shell', 'run_script', 'run_lark_cli'])

export function isProcessToolName(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && PROCESS_TOOL_NAMES.has(toolName)
}

function safeRedaction(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof source.redacted === 'boolean') out.redacted = source.redacted
  if (source.redactionReason === 'absolute_path' || source.redactionReason === 'ambiguous_path' || source.redactionReason === 'secret') {
    out.redactionReason = source.redactionReason
  }
  if (typeof source.originalBytes === 'number') out.originalBytes = source.originalBytes
  if (typeof source.visibleBytes === 'number') out.visibleBytes = source.visibleBytes
  return Object.keys(out).length ? out : undefined
}

function projectDiagnostic(value: unknown, sink: ProcessProjectionSink): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of DIAGNOSTIC_KEYS) {
    const entry = source[key]
    if (key === 'code' || key === 'caseId') {
      if (typeof entry === 'string' && (sink !== 'telemetry' || STABLE_CODE_RE.test(entry))) out[key] = entry
    } else if (typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number' || entry === null) {
      out[key] = sink === 'telemetry' && typeof entry === 'string' && !STABLE_CODE_RE.test(entry)
        ? undefined
        : entry
    }
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
  return Object.keys(out).length ? out : undefined
}

function projectPathValue(
  key: 'cwd' | 'executable',
  value: string,
  sink: ProcessProjectionSink,
  options: ProcessProjectionOptions
): { value?: string; scope: PathScope } {
  const scope = classifyPath(value, options)
  if (sink === 'telemetry') return { scope }
  if (scope === 'system') return { value: normalizePath(value), scope }
  if (scope === 'workspace' && options.workspaceRoot) {
    return { value: relativeToWorkspace(value, options.workspaceRoot), scope }
  }
  if (scope === 'external' && key === 'executable') return { value: basename(value), scope }
  return { scope }
}

function projectProcessDataForSink(
  source: Record<string, unknown>,
  sink: ProcessProjectionSink,
  options: ProcessProjectionOptions
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const processFacts = isPathLikeData(source)
  const maxOutputChars = Math.max(1, Math.floor(options.maxOutputChars ?? 32 * 1024))
  for (const [key, entry] of Object.entries(source)) {
    if (!PROCESS_KEYS.has(key)) continue
    if (key === 'persistedOutputPath') {
      if (typeof entry === 'string') out.artifactId = artifactIdForPersistedPath(entry)
      continue
    }
    if (key === 'cwd' || key === 'executable') {
      if (typeof entry !== 'string') continue
      const projected = projectPathValue(key, entry, sink, options)
      if (sink === 'telemetry') {
        out[`${key}Scope`] = projected.scope
        out[`${key}Fingerprint`] = fingerprint(normalizePath(entry), options)
      } else if (projected.value !== undefined && (key !== 'executable' || (processFacts && source.processResult !== null))) {
        out[key] = projected.value
      }
      continue
    }
    if (key === 'stdout' || key === 'stderr') {
      if (sink === 'telemetry') {
        if (!(`${key}Bytes` in out) && typeof entry === 'string') out[`${key}Bytes`] = new TextEncoder().encode(entry).byteLength
        if (!(`${key}Sha256` in out) && typeof entry === 'string') out[`${key}Sha256`] = fingerprint(entry, options)
      } else if (typeof entry === 'string') {
        const safe = sanitizeAgentText(entry).text
        out[key] = safe.length <= maxOutputChars
          ? safe
          : `${safe.slice(0, maxOutputChars)}…[output truncated]`
        if (safe.length > maxOutputChars) out.truncated = true
      }
      continue
    }
    if (key === 'stdoutRedaction' || key === 'stderrRedaction') {
      const redaction = safeRedaction(entry)
      if (redaction) out[key] = redaction
      continue
    }
    if (key === 'code') {
      if (typeof entry === 'string' && STABLE_CODE_RE.test(entry)) out[key] = entry
      continue
    }
    if (key === 'status') {
      if (typeof entry === 'string' && SAFE_STATUS.has(entry)) out[key] = entry
      continue
    }
    if (key === 'terminationReason') {
      if (typeof entry === 'string' && SAFE_TERMINATION_REASONS.has(entry)) out[key] = entry
      continue
    }
    if (key === 'signal' || key === 'terminationSignal') {
      if (entry === null || (typeof entry === 'string' && SAFE_SIGNAL_RE.test(entry))) out[key] = entry
      continue
    }
    if (key === 'shell') {
      if (typeof entry === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(entry)) out[key] = entry
      continue
    }
    if (key.endsWith('Sha256') || key.endsWith('Fingerprint') || key === 'planDigest') {
      if (typeof entry === 'string' && SAFE_HASH_RE.test(entry)) out[key] = entry
      continue
    }
    if (key.endsWith('Code') || key === 'caseId' || key === 'artifactId') {
      if (key === 'exitCode' && (typeof entry === 'number' || entry === null)) out[key] = entry
      else if (typeof entry === 'string' && (key === 'artifactId' || key === 'caseId' || STABLE_CODE_RE.test(entry))) out[key] = entry
      continue
    }
    if (key === 'processResult' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out[key] = projectProcessDataForSink(entry as Record<string, unknown>, sink, options)
      continue
    }
    if (typeof entry === 'string' && SECRET_KEY_RE.test(key)) {
      out[key] = '<secret:redacted>'
      continue
    }
    if (sink === 'telemetry' && (key === 'code' || key === 'planDigest')) {
      if (typeof entry === 'string' && STABLE_CODE_RE.test(entry)) out[key] = entry
      continue
    }
    if (sink === 'telemetry' && (key === 'status' || key === 'artifactId' || key === 'shell' || key.endsWith('Bytes') || key.endsWith('Sha256') || key.endsWith('Code') || key.endsWith('Id') || key.endsWith('Reason') || typeof entry === 'number' || typeof entry === 'boolean' || entry === null)) {
      out[key] = entry
      continue
    }
    if (sink !== 'telemetry') out[key] = entry
  }
  return out
}

const MAX_AGENT_DATA_DEPTH = 32
const MAX_AGENT_DATA_NODES = 10_000

function validateInputGraph(
  value: unknown,
  state = { seen: new WeakSet<object>(), nodes: 0 },
  depth = 0
): void {
  if (!value || typeof value !== 'object') return
  if (depth > MAX_AGENT_DATA_DEPTH) throw new Error('agent tool result exceeds maximum depth')
  if (state.seen.has(value)) throw new Error('agent tool result contains circular reference')
  state.seen.add(value)
  state.nodes += 1
  if (state.nodes > MAX_AGENT_DATA_NODES) throw new Error('agent tool result exceeds maximum nodes')
  try {
    for (const entry of Object.values(value as Record<string, unknown>)) validateInputGraph(entry, state, depth + 1)
  } finally {
    state.seen.delete(value)
  }
}

function projectGenericData(
  value: unknown,
  options: ProcessProjectionOptions,
  state = { seen: new WeakSet<object>(), nodes: 0 },
  depth = 0
): unknown {
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value ?? null
    // 普通/MCP 工具的总大小由调用链的统一 compact 逻辑控制；这里不把
    // 业务字符串误当成 stdout 截断，避免改变合法工具的返回语义。
    return sanitizeAgentText(value).text
  }
  if (depth > MAX_AGENT_DATA_DEPTH) throw new Error('agent tool result exceeds maximum depth')
  if (state.seen.has(value)) throw new Error('agent tool result contains circular reference')
  state.seen.add(value)
  state.nodes += 1
  if (state.nodes > MAX_AGENT_DATA_NODES) throw new Error('agent tool result exceeds maximum nodes')
  try {
    if (Array.isArray(value)) return value.map((entry) => projectGenericData(entry, options, state, depth + 1))
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(source)) {
      if (key === 'persistedOutputPath' && typeof entry === 'string') {
        out.artifactId = artifactIdForPersistedPath(entry)
        continue
      }
      if (SECRET_KEY_RE.test(key)) {
        out[key] = '<secret:redacted>'
        continue
      }
      out[key] = projectGenericData(entry, options, state, depth + 1)
    }
    return out
  } finally {
    state.seen.delete(value)
  }
}

export function projectToolResultForSink(
  result: ProjectableToolResult,
  sink: ProcessProjectionSink,
  options: ProcessProjectionOptions = {}
): ProjectableToolResult | ProjectedTelemetryResult {
  validateInputGraph(result.data)
  const processData = options.processTool === true && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
  const diagnostic = projectDiagnostic(result.diagnostic, sink)
  if (sink === 'telemetry') {
    const data = processData
      ? projectProcessDataForSink(result.data as Record<string, unknown>, sink, options)
      : null
    const errorCode = typeof result.error === 'string' && STABLE_CODE_RE.test(result.error) ? result.error : undefined
    return { ok: result.success, ...(errorCode ? { errorCode } : {}), ...(diagnostic ? { diagnostic } : {}), data }
  }
  const safeError = typeof result.error === 'string' ? sanitizeAgentText(result.error).text : undefined
  const safeUserMessage = typeof result.userMessage === 'string' ? sanitizeAgentText(result.userMessage).text : undefined
  return {
    success: result.success,
    ...(safeError && (!processData || STABLE_CODE_RE.test(safeError)) ? { error: safeError } : processData ? { error: 'TOOL_EXECUTION_FAILED' } : {}),
    ...(safeUserMessage ? { userMessage: safeUserMessage } : {}),
    data: processData ? projectProcessDataForSink(result.data as Record<string, unknown>, sink, options) : projectGenericData(result.data, options),
    ...(diagnostic ? { diagnostic } : {})
  }
}

/** Agent 模型输入和本地历史的同一份安全投影。 */
export function projectAgentToolResultForSink(
  result: ProjectableToolResult,
  options: ProcessProjectionOptions = {}
): ProjectableToolResult {
  try {
    return projectToolResultForSink(result, 'agent', options) as ProjectableToolResult
  } catch {
    return { success: false, error: 'SHELL_RESULT_SERIALIZATION_FAILED', data: null }
  }
}

/** 本地历史必须重放 Agent 实际看到的结果，不另起一套脱敏规则。 */
export function projectLocalHistoryToolResult(
  result: ProjectableToolResult,
  options: ProcessProjectionOptions = {}
): ProjectableToolResult {
  try {
    return projectToolResultForSink(result, 'local_history', options) as ProjectableToolResult
  } catch {
    return { success: false, error: 'SHELL_RESULT_SERIALIZATION_FAILED', data: null }
  }
}

/** 远程日志/telemetry 的严格结构化出口。 */
export function projectTelemetryToolResult(
  result: ProjectableToolResult,
  options: ProcessProjectionOptions = {}
): ProjectedTelemetryResult {
  try {
    return projectToolResultForSink(result, 'telemetry', options) as ProjectedTelemetryResult
  } catch {
    return { ok: false, errorCode: 'SHELL_RESULT_SERIALIZATION_FAILED', data: null }
  }
}

export { classifyPath, projectDiagnostic, projectProcessDataForSink }
