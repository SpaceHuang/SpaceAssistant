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
/** 带凭据限定词的键名（apiKey / x-api-key / accessToken / clientSecret / sessionToken ...）。 */
const QUALIFIED_SECRET_KEY_RE = /(?:api|access|secret|private|client|auth|bearer|signing|session)[_-]?(?:key|token|secret)s?$/i
/** 独立凭据键名（token / secret / userPassword / set-cookie / authorization ...）。 */
const STANDALONE_SECRET_KEY_RE = /(?:token|secret|cookie|password|passwd|credential|credentials|authorization|passphrase)s?$/i
/** 裸 key / keys：只在值确实像凭据时才脱敏。 */
const BARE_KEY_RE = /^keys?$/i
const SECRET_LIKE_VALUE_RE =
  /^(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+\S+|[A-Za-z0-9+/]{40,}={0,2}|[A-Fa-f0-9]{32,})$/

/**
 * 判断某个键的值是否必须脱敏。
 *
 * 早先的实现只要键名包含 `key` 就整段替换成 `<secret:redacted>`，于是 `{keyCode: 13}`、
 * `{key: 'Enter'}`、`{monkey: ...}`、`{keys: [...]}` 这类合法数据全部丢失，静默打断
 * "工具 A 返回 token、模型传给工具 B"的流程。现在按三级判定：
 * 限定词键名 → 独立凭据键名 → 裸 key/keys 仅在值看起来像凭据时脱敏。
 */
function shouldRedactValue(key: string, value: unknown): boolean {
  if (QUALIFIED_SECRET_KEY_RE.test(key) || STANDALONE_SECRET_KEY_RE.test(key)) return true
  if (!BARE_KEY_RE.test(key)) return false
  return looksLikeSecretValue(value)
}

/** 裸 key/keys 的值形态不定（单值或数组），任一元素像凭据即整体脱敏。 */
function looksLikeSecretValue(value: unknown): boolean {
  if (typeof value === 'string') return SECRET_LIKE_VALUE_RE.test(value.trim())
  if (Array.isArray(value)) return value.some((entry) => looksLikeSecretValue(entry))
  return false
}
const PROCESS_KEYS = new Set([
  'status', 'code', 'errorCode', 'caseId', 'exitCode', 'signal', 'terminationReason', 'interrupted',
  'timedOut', 'cancelled', 'truncated', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes',
  'stdoutSha256', 'stderrSha256', 'stdoutRedaction', 'stderrRedaction', 'outputArtifactBytes',
  'outputArtifactSha256', 'outputPersistErrorCode', 'terminationErrorCode', 'terminationSignal',
  'treeKillVerified', 'outputLimitReached', 'captureCaseId', 'progressCaseId', 'terminationCaseId',
  'artifactId', 'persistedOutputPath', 'shell', 'planDigest', 'retryCount', 'retryExhausted',
  'processResult', 'cwd', 'executable', 'durationMs', 'artifactAvailable', 'redacted',
  // 需求 §9.4-§9.6 / §10.4：编码契约、字节口径与解码诊断
  'stdoutEncoding', 'stderrEncoding', 'encodingSource', 'encodingConfidence', 'contractKind',
  'contractConflict', 'lossStage', 'outputTrust', 'outputDiag', 'decodeReplacements', 'decode', 'contract',
  'stdoutRawBytes', 'stderrRawBytes', 'stdoutTextBytes', 'stderrTextBytes', 'stdoutRawSha256', 'stderrRawSha256',
  'rawArtifact', 'outputArtifactReason', 'exitCodeHint', 'exitCodeFamily', 'exitCodeSemantics', 'exitCodeAdvice',
  'hresult', 'planMs', 'spawnToExitMs',
  // §10.3：方言错配等计划错误的结构化 data（signals/hints 必须到达模型）
  'signals', 'hints', 'detectedSyntax', 'expectedDialect', 'shellProfileId', 'reason'
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

/** 无法安全暴露 artifact 主键时的兜底值；渲染层不得用它调用打开接口（主进程必然拒绝）。 */
export const REDACTED_ARTIFACT_ID = 'artifact-redacted'

export function artifactIdForPersistedPath(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  return /^[0-9a-f]{64}\.log$/i.test(name) ? `artifact-${name.slice(0, -4)}` : REDACTED_ARTIFACT_ID
}

/** [output-diag] 行允许的 artifact 引用形态。 */
const SAFE_ARTIFACT_REF_RE = /^(?:none|artifact-(?:redacted|[0-9a-f]{64}))$/

/**
 * 诊断行里的 artifact 引用只允许 `none` / `artifact-<64hex>` / `artifact-redacted`。
 * 传入持久化绝对路径（含 OS 用户名）时按同一规则降级：只有 basename 命中
 * `<64hex>.log` 才保留可追溯 id，否则一律 `artifact-redacted`。
 */
export function sanitizeArtifactRef(value: string | undefined): string {
  if (value === undefined) return 'none'
  const trimmed = value.trim()
  if (trimmed.length === 0) return 'none'
  const normalized = trimmed.toLowerCase()
  if (SAFE_ARTIFACT_REF_RE.test(normalized)) return normalized
  return artifactIdForPersistedPath(trimmed)
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

const SAFE_ENCODING_LABEL_RE = /^[A-Za-z0-9_.:-]{1,32}$/
const SAFE_ENCODING_SOURCES = new Set(['bom', 'utf16-pattern', 'utf16-structure', 'strict-utf8', 'contract', 'oem-codepage', 'fallback-latin1'])
const SAFE_CONFIDENCE = new Set(['exact', 'high', 'medium', 'low'])
const SAFE_CONTRACT_KINDS = new Set(['auto', 'utf8', 'oem', 'utf16le'])
const SAFE_EXIT_CODE_FAMILIES = new Set(['success', 'posix', 'windows-host', 'unknown-windows-host'])
const SAFE_LOSS_STAGES = new Set(['host'])
const SAFE_ARTIFACT_REASONS = new Set(['failed', 'suspect', 'truncated', 'size'])
const SAFE_ENCODING_SOURCE_KEYS = new Set(['encodingSource', 'encodingConfidence', 'contractConflict', 'lossStage', 'outputTrust', 'exitCodeFamily', 'contractKind'])

/** 单条流的解码诊断（§10.4）：只放行结构化的枚举与计数，不携带任何文本。 */
function projectDecodeBlock(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const key of ['stdout', 'stderr'] as const) {
    const stream = (value as Record<string, unknown>)[key]
    if (!stream || typeof stream !== 'object' || Array.isArray(stream)) continue
    const source = stream as Record<string, unknown>
    const projected: Record<string, unknown> = {}
    if (typeof source.encoding === 'string' && SAFE_ENCODING_LABEL_RE.test(source.encoding)) projected.encoding = source.encoding
    if (typeof source.source === 'string' && SAFE_ENCODING_SOURCES.has(source.source)) projected.source = source.source
    if (typeof source.confidence === 'string' && SAFE_CONFIDENCE.has(source.confidence)) projected.confidence = source.confidence
    if (typeof source.replacements === 'number') projected.replacements = source.replacements
    if (typeof source.suspect === 'boolean') projected.suspect = source.suspect
    if (Object.keys(projected).length > 0) out[key] = projected
  }
  const root = value as Record<string, unknown>
  if (root.contractConflict === 'contract-mismatch') out.contractConflict = root.contractConflict
  if (typeof root.lossStage === 'string' && SAFE_LOSS_STAGES.has(root.lossStage)) out.lossStage = root.lossStage
  return Object.keys(out).length > 0 ? out : undefined
}

/** 生效契约（§7.1）：只放行判别式与代码页。 */
function projectContractBlock(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (typeof source.kind !== 'string' || !SAFE_CONTRACT_KINDS.has(source.kind)) return undefined
  const out: Record<string, unknown> = { kind: source.kind }
  if (source.kind === 'oem' && typeof source.codepage === 'number') out.codepage = source.codepage
  return out
}

/** 原始字节留档（§9.4）：绝对路径一律降级为 artifactId，与 persistedOutputPath 同规则。 */
function projectRawArtifactBlock(value: unknown, sink: ProcessProjectionSink): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof source.path === 'string') out.artifactId = artifactIdForPersistedPath(source.path)
  for (const key of ['bytes', 'rawBytes', 'omittedBytes'] as const) {
    if (typeof source[key] === 'number') out[key] = source[key]
  }
  if (typeof source.truncated === 'boolean') out.truncated = source.truncated
  if (typeof source.suspect === 'boolean') out.suspect = source.suspect
  if (typeof source.sha256 === 'string' && SAFE_HASH_RE.test(source.sha256)) out.sha256 = source.sha256
  if (source.note === 'unredacted') out.note = source.note
  if (Object.keys(out).length === 0) return undefined
  if (sink === 'telemetry' && out.artifactId === REDACTED_ARTIFACT_ID) delete out.artifactId
  return out
}

/** HRESULT 解释（§10.2）：name/semantics 是稳定常量，advice 必须逐条脱敏。 */
function projectHresultBlock(value: unknown, sink: ProcessProjectionSink): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof source.code === 'string' && /^0x[0-9A-F]{8}$/.test(source.code)) out.code = source.code
  if (typeof source.name === 'string' && STABLE_CODE_RE.test(source.name)) out.name = source.name
  // MINOR：指令性文本与 hints 口径一致，telemetry 只留 code/name 这类稳定枚举。
  if (sink !== 'telemetry') {
    const meaning = sanitizeAdviceText(source.meaning)
    if (meaning) out.meaning = meaning
    const advice = sanitizeAdviceList(source.advice)
    if (advice) out.advice = advice
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeAdviceText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = sanitizeAgentText(value).text
  return text.length > 0 && text.length <= 512 ? text : undefined
}

function sanitizeAdviceList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value.slice(0, 8)) {
    const text = sanitizeAdviceText(entry)
    if (text) out.push(text)
  }
  return out.length > 0 ? out : undefined
}

/** 稳定代码列表（如方言错配 signals）：逐项校验形态，不携带自由文本。 */
function sanitizeCodeList(value: unknown, pattern: RegExp): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value
    .filter((entry): entry is string => typeof entry === 'string' && pattern.test(entry))
    .slice(0, 16)
  return out.length > 0 ? out : undefined
}

const DIAG_ARTIFACT_TOKEN = ' rawArtifact='

/**
 * [output-diag] 行是纯 ASCII 机器可读诊断；只放行前缀正确且长度受限的行。
 * 额外把 `rawArtifact=` 值降级为 artifactId：即使生成端未来回退成拼绝对路径，
 * 绝对路径（含 OS 用户名）也不会抵达模型上下文、历史与遥测。
 */
function sanitizeDiagnosticLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value.slice(0, 4)) {
    if (typeof entry !== 'string') continue
    if (!entry.startsWith('[output-diag] ') || entry.length > 1024) continue
    out.push(sanitizeDiagnosticLine(entry))
  }
  return out.length > 0 ? out : undefined
}

function sanitizeDiagnosticLine(entry: string): string {
  const index = entry.indexOf(DIAG_ARTIFACT_TOKEN)
  if (index < 0) return entry
  const head = entry.slice(0, index)
  const rawValue = entry.slice(index + DIAG_ARTIFACT_TOKEN.length)
  return `${head}${DIAG_ARTIFACT_TOKEN}${sanitizeArtifactRef(rawValue)}`
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

/**
 * §10.3：`reason` 是计划期诊断的自由文本，只允许随计划错误 payload（稳定 SHELL_* code）
 * 或方言错配标记一起转发。普通进程结果里的未知 `reason`（例如 spawn 失败的原始诊断）
 * 必须被丢弃，否则会绕开「未知字段不进 Agent payload」的既有契约。
 */
function hasPlanDiagnosticMarker(source: Record<string, unknown>): boolean {
  if (typeof source.detectedSyntax === 'string' || typeof source.expectedDialect === 'string') return true
  if (source.signals !== undefined) {
    // MINOR：signals 必须是「合法且非空」的 code 列表，才为 reason 放行自由文本；
    // 否则任意数组（例如 [{ injected: true }]）都能成为绕开白名单的通道。
    const signals = sanitizeCodeList(source.signals, /^[a-z0-9:_-]{1,32}$/)
    if (signals && signals.length > 0) return true
  }
  return typeof source.code === 'string' && /^SHELL_[A-Z0-9_]{1,48}$/.test(source.code)
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
    if (key === 'decode') {
      const projected = projectDecodeBlock(entry)
      if (projected) out[key] = projected
      continue
    }
    if (key === 'contract') {
      const projected = projectContractBlock(entry)
      if (projected) out[key] = projected
      continue
    }
    if (key === 'rawArtifact') {
      const projected = projectRawArtifactBlock(entry, sink)
      if (projected) out[key] = projected
      continue
    }
    if (key === 'hresult') {
      const projected = projectHresultBlock(entry, sink)
      if (projected) out[key] = projected
      continue
    }
    if (key === 'signals') {
      const signals = sanitizeCodeList(entry, /^[a-z0-9:_-]{1,32}$/)
      if (signals) out[key] = signals
      continue
    }
    if (key === 'hints') {
      // 指令性文本：逐条脱敏（§10.3 注），telemetry 不落文本
      if (sink !== 'telemetry') {
        const hints = sanitizeAdviceList(entry)
        if (hints) out[key] = hints
      }
      continue
    }
    if (key === 'detectedSyntax' || key === 'expectedDialect' || key === 'shellProfileId') {
      if (typeof entry === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(entry)) out[key] = entry
      continue
    }
    if (key === 'reason') {
      if (sink !== 'telemetry' && hasPlanDiagnosticMarker(source)) {
        const text = sanitizeAdviceText(entry)
        if (text) out[key] = text
      }
      continue
    }
    if (key === 'outputDiag') {
      const lines = sanitizeDiagnosticLines(entry)
      if (lines) out[key] = lines
      continue
    }
    if (key === 'exitCodeAdvice') {
      if (sink !== 'telemetry') {
        const advice = sanitizeAdviceList(entry)
        if (advice) out[key] = advice
      }
      continue
    }
    if (key === 'exitCodeHint' || key === 'exitCodeSemantics') {
      if (key === 'exitCodeSemantics' && typeof entry === 'string' && STABLE_CODE_RE.test(entry)) {
        out[key] = entry
        continue
      }
      const text = key === 'exitCodeHint' ? sanitizeAdviceText(entry) : undefined
      if (text && sink !== 'telemetry') out[key] = text
      continue
    }
    if (key === 'outputArtifactReason') {
      if (typeof entry === 'string' && SAFE_ARTIFACT_REASONS.has(entry)) out[key] = entry
      continue
    }
    if (SAFE_ENCODING_SOURCE_KEYS.has(key)) {
      const allowed =
        key === 'encodingSource' ? SAFE_ENCODING_SOURCES
        : key === 'encodingConfidence' ? SAFE_CONFIDENCE
        : key === 'contractKind' ? SAFE_CONTRACT_KINDS
        : key === 'exitCodeFamily' ? SAFE_EXIT_CODE_FAMILIES
        : key === 'lossStage' ? SAFE_LOSS_STAGES
        : undefined
      if (allowed) {
        if (typeof entry === 'string' && allowed.has(entry)) out[key] = entry
        continue
      }
      if (key === 'contractConflict') {
        if (entry === 'contract-mismatch') out[key] = entry
        continue
      }
      if (key === 'outputTrust') {
        if (entry === 'ok' || entry === 'suspect') out[key] = entry
        continue
      }
      continue
    }
    if (key === 'stdoutEncoding' || key === 'stderrEncoding') {
      if (typeof entry === 'string' && SAFE_ENCODING_LABEL_RE.test(entry)) out[key] = entry
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
    if (typeof entry === 'string' && shouldRedactValue(key, entry)) {
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
      if (shouldRedactValue(key, entry)) {
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
