import { z } from 'zod'

/**
 * MCP 外部能力接入的共享类型与纯函数。
 * 本文件不依赖任何 Node/Electron API，渲染进程可直接复用。
 * 本文件中的类型一律为「可读、非敏感」类型：不得出现 token、环境变量值、
 * OAuth code、密文或可恢复的 Secret 长度字段。
 */

export const MCP_MAX_SERVERS = 20
export const MCP_SERVER_NAME_MAX = 64
export const MCP_TIMEOUT_SEC_DEFAULT = 60
export const MCP_TIMEOUT_SEC_MIN = 5
export const MCP_TIMEOUT_SEC_MAX = 300
export const MCP_CONNECT_TIMEOUT_MS = 15_000
export const MCP_PER_SERVER_CONCURRENCY = 4
export const MCP_GLOBAL_CONCURRENCY = 8
export const MCP_TOOLS_PER_ROUND_MAX = 64
export const MCP_TOOLS_TOTAL_BYTES_MAX = 96 * 1024
export const MCP_TOOL_SCHEMA_MAX_BYTES = 16 * 1024
export const MCP_TOOL_SCHEMA_MAX_DEPTH = 20
export const MCP_CALL_ARGS_MAX_BYTES = 256 * 1024
export const MCP_CALL_ARGS_MAX_DEPTH = 20
export const MCP_TOOL_NAME_MAX = 64
export const MCP_DIAGNOSTICS_MAX_PER_SERVER = 20
export const MCP_DIAGNOSTICS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type McpTransportType = 'stdio' | 'streamable-http'
export type McpAuthMode = 'none' | 'bearer-token' | 'custom-header' | 'oauth'
export type McpConnectionStatus =
  | 'untested'
  | 'connecting'
  | 'auth-required'
  | 'auth-expired'
  | 'connected'
  | 'failed'
  | 'no-tools'
  | 'disabled'

export type McpToolConfirmPolicy = 'always' | 'readonly-auto'

export type McpToolAnnotations = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolDescriptor {
  serverId: string
  originalName: string
  mappedName: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: McpToolAnnotations
  discoveredAt: string
}

export interface McpServerProfile {
  id: string
  name: string
  enabled: boolean
  transport: McpTransportType
  timeoutSec: number
  auth: {
    mode: McpAuthMode
    secretPresent: boolean
    headerName?: string
    valuePrefix?: string
    oauthClientId?: string
    oauthScopes?: string[]
    accessTokenExpiresAt?: string
  }
  stdio?: {
    command: string
    args: string[]
    cwd?: string
    /** 变量值只存在于一次性写入 payload 与主进程 Secret Store。 */
    env: Array<{ key: string; valuePresent: boolean }>
    commandTrustedAt?: string
  }
  http?: { endpoint: string }
  enabledToolNames: string[]
  toolConfirmPolicy: McpToolConfirmPolicy
  discoveredAt?: string
  discoveredProtocolVersion?: string
  status: McpConnectionStatus
  lastError?: { code: string; message: string; occurredAt: string }
  createdAt: string
  updatedAt: string
}

/** 主进程写入用的仅输入类型；Secret 字段只出现在专用 IPC 请求体。 */
export interface McpServerWriteInput {
  id: string
  name: string
  enabled: boolean
  transport: McpTransportType
  timeoutSec: number
  auth: {
    mode: McpAuthMode
    headerName?: string
    valuePrefix?: string
    oauthClientId?: string
    oauthScopes?: string[]
    accessTokenExpiresAt?: string
    /** 一次性写入：留空表示不修改。 */
    accessToken?: string
    headerValue?: string
  }
  stdio?: {
    command: string
    args: string[]
    cwd?: string
    env: Array<{ key: string; valuePresent: boolean; value?: string; clear?: boolean }>
    commandTrustedAt?: string
  }
  http?: { endpoint: string }
  enabledToolNames: string[]
  toolConfirmPolicy: McpToolConfirmPolicy
  createdAt?: string
  updatedAt?: string
  clearSecretKinds?: string[]
}

/** 每服务工具缓存（config.mcpToolCache.<serverId>）。 */
export interface McpToolCacheEntry {
  tools: McpToolDescriptor[]
  protocolVersion: string
  discoveredAt: string
  /** notifications/tools/list_changed 后标记为待刷新。 */
  stale?: boolean
  /** 校验未通过的工具数（展示「未注入」/跳过提示）。 */
  skippedCount?: number
}

/** 脱敏后的错误诊断条目。 */
export interface McpDiagnosticEntry {
  id: string
  code: string
  message: string
  occurredAt: string
}

export type McpSecretKind =
  | 'access-token'
  | 'refresh-token'
  | 'auth-header'
  | `env:${string}`

/** mcp:list 返回的脱敏配置（不含任何 Secret 明文/密文）。 */
export interface McpConfig {
  servers: McpServerProfile[]
  /** 每服务工具缓存（非敏感），供设置页展示工具列表与启用状态。 */
  toolCaches?: Record<string, McpToolCacheEntry>
}

export interface McpSaveProfilesPayload {
  servers: McpServerWriteInput[]
}

export interface McpSaveProfilesResult {
  servers: McpServerProfile[]
}

export interface McpTestConnectionPayload {
  server: McpServerWriteInput
}

export type McpTestConnectionResult =
  | {
      ok: true
      serverName: string
      protocolVersion: string
      capabilities: Record<string, unknown>
      tools: McpToolDescriptor[]
      skipped: Array<{ name: string; reason: string }>
    }
  | { ok: false; code: string; message: string }

export interface McpClearSecretPayload {
  serverId: string
  kind: string
}

export interface McpDeleteServerPayload {
  serverId: string
}

export interface McpRefreshToolsPayload {
  serverId: string
}

export type McpRefreshToolsResult =
  | { ok: true; serverName: string; tools: McpToolDescriptor[] }
  | { ok: false; code: string; message: string }

export interface McpGetDiagnosticsPayload {
  serverId: string
}

export interface McpOauthStartPayload {
  serverId: string
}

export type McpOauthStartResult =
  | { ok: true }
  | { ok: false; code: string; message: string }

const MCP_CONNECTION_STATUSES = [
  'untested',
  'connecting',
  'auth-required',
  'auth-expired',
  'connected',
  'failed',
  'no-tools',
  'disabled'
] as const

const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function uniqueStrings(items: string[]): boolean {
  return new Set(items).size === items.length
}

const McpAuthSchema = z.object({
  mode: z.enum(['none', 'bearer-token', 'custom-header', 'oauth']),
  secretPresent: z.boolean(),
  headerName: z.string().max(128).optional(),
  valuePrefix: z.string().max(128).optional(),
  oauthClientId: z.string().max(256).optional(),
  oauthScopes: z.array(z.string().max(256)).max(32).optional(),
  accessTokenExpiresAt: z.string().max(64).optional()
})

const McpStdioSchema = z.object({
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(2048)).max(256),
  cwd: z.string().max(1024).optional(),
  env: z
    .array(z.object({ key: z.string().regex(MCP_ENV_KEY_RE), valuePresent: z.boolean() }))
    .max(64),
  commandTrustedAt: z.string().max(64).optional()
})

const McpHttpSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048)
})

/**
 * 读取校验 + 迁移用：容忍未知字段（strip），并按传输类型做条件必填校验。
 */
export const McpServerProfileSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(MCP_SERVER_NAME_MAX),
    enabled: z.boolean(),
    transport: z.enum(['stdio', 'streamable-http']),
    timeoutSec: z
      .number()
      .int()
      .min(MCP_TIMEOUT_SEC_MIN)
      .max(MCP_TIMEOUT_SEC_MAX),
    auth: McpAuthSchema,
    stdio: McpStdioSchema.optional(),
    http: McpHttpSchema.optional(),
    enabledToolNames: z
      .array(z.string().min(1).max(256))
      .max(512)
      .refine(uniqueStrings, { message: 'enabledToolNames must be unique' }),
    toolConfirmPolicy: z.enum(['always', 'readonly-auto']),
    discoveredAt: z.string().max(64).optional(),
    discoveredProtocolVersion: z.string().max(32).optional(),
    status: z.enum(MCP_CONNECTION_STATUSES),
    lastError: z
      .object({
        code: z.string().max(64),
        message: z.string().max(2000),
        occurredAt: z.string().max(64)
      })
      .optional(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio' && !v.stdio) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stdio required', path: ['stdio'] })
    }
    if (v.transport === 'streamable-http' && !v.http) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'http required', path: ['http'] })
    }
  })

const McpWriteAuthSchema = z
  .object({
    mode: z.enum(['none', 'bearer-token', 'custom-header', 'oauth']),
    headerName: z.string().max(128).optional(),
    valuePrefix: z.string().max(128).optional(),
    oauthClientId: z.string().max(256).optional(),
    oauthScopes: z.array(z.string().max(256)).max(32).optional(),
    accessTokenExpiresAt: z.string().max(64).optional(),
    accessToken: z.string().max(8192).optional(),
    headerValue: z.string().max(8192).optional()
  })
  .strict()

const McpWriteStdioSchema = z
  .object({
    command: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(2048)).max(256),
    cwd: z.string().max(1024).optional(),
    env: z
      .array(
        z
          .object({
            key: z.string().regex(MCP_ENV_KEY_RE),
            valuePresent: z.boolean(),
            value: z.string().max(8192).optional(),
            clear: z.boolean().optional()
          })
          .strict()
      )
      .max(64),
    commandTrustedAt: z.string().max(64).optional()
  })
  .strict()

const McpWriteHttpSchema = z.object({ endpoint: z.string().trim().min(1).max(2048) }).strict()

/**
 * IPC 请求体专用：strict() 禁止未知字段，杜绝 Secret 泄漏进意外位置。
 */
export const McpServerWriteInputSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(MCP_SERVER_NAME_MAX),
    enabled: z.boolean(),
    transport: z.enum(['stdio', 'streamable-http']),
    timeoutSec: z
      .number()
      .int()
      .min(MCP_TIMEOUT_SEC_MIN)
      .max(MCP_TIMEOUT_SEC_MAX),
    auth: McpWriteAuthSchema,
    stdio: McpWriteStdioSchema.optional(),
    http: McpWriteHttpSchema.optional(),
    enabledToolNames: z
      .array(z.string().min(1).max(256))
      .max(512)
      .refine(uniqueStrings, { message: 'enabledToolNames must be unique' }),
    toolConfirmPolicy: z.enum(['always', 'readonly-auto']),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    clearSecretKinds: z.array(z.string().min(1).max(256)).max(64).optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio' && !v.stdio) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stdio required', path: ['stdio'] })
    }
    if (v.transport === 'streamable-http' && !v.http) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'http required', path: ['http'] })
    }
  })

/** 读取 config.mcpServers：缺失/损坏返回空数组，非法条目丢弃。 */
export function parseMcpServerProfiles(raw: string | null | undefined): McpServerProfile[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: McpServerProfile[] = []
    for (const item of parsed) {
      const result = McpServerProfileSchema.safeParse(item)
      if (result.success) out.push(result.data)
    }
    return out
  } catch {
    return []
  }
}

/** 工具缓存读取：缺失/损坏返回 null。 */
export function parseMcpToolCache(raw: string | null | undefined): McpToolCacheEntry | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      tools?: unknown
      protocolVersion?: unknown
      discoveredAt?: unknown
      stale?: unknown
      skippedCount?: unknown
    }
    if (!Array.isArray(parsed.tools)) return null
    const tools: McpToolDescriptor[] = []
    for (const item of parsed.tools) {
      const r = McpToolDescriptorSchema.safeParse(item)
      if (r.success) tools.push(r.data)
    }
    return {
      tools,
      protocolVersion: typeof parsed.protocolVersion === 'string' ? parsed.protocolVersion : '',
      discoveredAt: typeof parsed.discoveredAt === 'string' ? parsed.discoveredAt : '',
      ...(parsed.stale === true ? { stale: true } : {}),
      ...(typeof parsed.skippedCount === 'number' ? { skippedCount: parsed.skippedCount } : {})
    }
  } catch {
    return null
  }
}

export const McpToolDescriptorSchema = z.object({
  serverId: z.string().min(1).max(128),
  originalName: z.string().min(1).max(256),
  mappedName: z.string().min(1).max(MCP_TOOL_NAME_MAX),
  description: z.string().max(4000),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional()
    })
    .optional(),
  discoveredAt: z.string()
})

/** 把服务名/工具名转成可读 slug（仅 [a-z0-9_]），为空时返回兜底。 */
export function slugifyMcpName(name: string, fallback: string): string {
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || fallback
}

/** FNV-1a 32 位哈希（纯 JS，跨平台稳定），输出 hex 字符串。 */
export function hashStringToHex(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export type MappedToolNameInput = {
  serverId: string
  serverName: string
  toolName: string
}

function buildMappedName(
  serverSlug: string,
  toolSlug: string,
  hash: string,
  suffix = ''
): string {
  const base = `mcp_${serverSlug}_${toolSlug}_${hash}${suffix}`
  return base.slice(0, MCP_TOOL_NAME_MAX)
}

/**
 * 生成映射工具名：`mcp_<serverSlug>_<toolSlug>_<shortHash>`。
 * hash 基于 serverId + 原始工具名，保证跨服务稳定且互不相同；超限截断 slug、保留 hash。
 */
export function generateMappedToolName(input: MappedToolNameInput): string {
  const serverSlug = slugifyMcpName(input.serverName, 's').slice(0, 16)
  const toolSlug = slugifyMcpName(input.toolName, 't').slice(0, 32)
  const hash = hashStringToHex(`${input.serverId}\0${input.toolName}`).slice(0, 8)
  return buildMappedName(serverSlug, toolSlug, hash)
}

/**
 * 映射名查重（评审 A6）：命中已用名时确定性再派生——先延长 hash，仍冲突再加计数后缀。
 * 传入字符串 base 时退化为「计数后缀」派生（无法重算更长 hash 的场景）。
 */
export function deriveUniqueMappedToolName(
  baseOrInput: string | MappedToolNameInput,
  used: ReadonlySet<string>
): string {
  if (typeof baseOrInput === 'string') {
    const base = baseOrInput
    if (!used.has(base)) return base
    for (let i = 2; i < 1000; i++) {
      const candidate = base.slice(0, MCP_TOOL_NAME_MAX - String(i).length - 1) + `_${i}`
      if (!used.has(candidate)) return candidate
    }
    throw new Error('无法派生唯一 MCP 映射工具名')
  }

  const serverSlug = slugifyMcpName(baseOrInput.serverName, 's').slice(0, 16)
  const toolSlug = slugifyMcpName(baseOrInput.toolName, 't').slice(0, 32)
  const fullHash = hashStringToHex(`${baseOrInput.serverId}\0${baseOrInput.toolName}`)

  for (const hashLen of [8, 12, 16, 20, 24, 32]) {
    const candidate = buildMappedName(serverSlug, toolSlug, fullHash.slice(0, hashLen))
    if (!used.has(candidate)) return candidate
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = buildMappedName(serverSlug, toolSlug, fullHash.slice(0, 32), `_${i}`)
    if (!used.has(candidate)) return candidate
  }
  throw new Error('无法派生唯一 MCP 映射工具名')
}

/**
 * 展示用 endpoint 规范化：移除 userinfo/query/fragment，host 小写。
 * 非法 URL 返回 null。
 */
export function sanitizeEndpointForDisplay(endpoint: string): string | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  if (url.username || url.password) {
    url.username = ''
    url.password = ''
  }
  url.search = ''
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  return url.origin + url.pathname
}

const SENSITIVE_FLAG_RE =
  /(^|[\s=])(--?[A-Za-z0-9_-]*(token|api[_-]?key|password|passwd|secret|client[_-]?secret|access[_-]?token|auth[_-]?header)(\s|=|$))/i
const SHORT_PASSWORD_FLAG_RE = /(^|[\s=])(-p)(\s|=|$)/i
const AUTHORIZATION_HEADER_RE = /authorization\s*:/i
const ANTHROPIC_KEY_RE = /sk-ant-[a-zA-Z0-9_-]+|sk-[a-zA-Z0-9_-]{20,}/g
const GITHUB_TOKEN_RE = /(ghp_|gho_|github_pat_)[a-zA-Z0-9_]+/g
const SLACK_TOKEN_RE = /xox[baprs]-[a-zA-Z0-9-]+|xoxe-[a-zA-Z0-9-]+/g
const GITLAB_TOKEN_RE = /glpat-[a-zA-Z0-9_-]+/g
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{1,}/g
const BEARER_RE = /bearer\s+\S+/gi
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/i

export type SensitiveParamDetectResult =
  | { matched: true; kind: 'flag' | 'authorization-header' | 'token' | 'jwt' | 'bearer' }
  | { matched: false }

/** 命令/参数中的敏感模式检测（token 格式 + 敏感 flag + Authorization 头）。 */
export function detectSensitiveParamValue(value: string): SensitiveParamDetectResult {
  if (SENSITIVE_FLAG_RE.test(value) || SHORT_PASSWORD_FLAG_RE.test(value)) {
    return { matched: true, kind: 'flag' }
  }
  if (AUTHORIZATION_HEADER_RE.test(value)) {
    return { matched: true, kind: 'authorization-header' }
  }
  if (JWT_RE.test(value)) {
    return { matched: true, kind: 'jwt' }
  }
  if (
    ANTHROPIC_KEY_RE.test(value) ||
    GITHUB_TOKEN_RE.test(value) ||
    SLACK_TOKEN_RE.test(value) ||
    GITLAB_TOKEN_RE.test(value) ||
    LONG_HEX_RE.test(value)
  ) {
    return { matched: true, kind: 'token' }
  }
  if (BEARER_RE.test(value)) {
    return { matched: true, kind: 'bearer' }
  }
  return { matched: false }
}

const SENSITIVE_KEY_RE =
  /token|secret|password|passwd|authorization|api[_-]?key|credential/i

function maskString(value: string): string {
  const detection = detectSensitiveParamValue(value)
  return detection.matched ? '[REDACTED]' : value
}

/**
 * 参数摘要脱敏：递归掩码敏感键（token/secret/password/authorization/apiKey）的值，
 * 并对普通键下 token 形态的字符串值做兜底掩码。
 */
export function maskSensitiveArgs(input: unknown): unknown {
  if (typeof input === 'string') return maskString(input)
  if (Array.isArray(input)) return input.map(maskSensitiveArgs)
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : maskSensitiveArgs(val)
    }
    return out
  }
  return input
}

export type McpBudgetTrimResult = {
  kept: McpToolDescriptor[]
  dropped: Array<{ tool: McpToolDescriptor; reason: 'count' | 'bytes' }>
}

/**
 * 按「服务配置数组顺序 → enabledToolNames 保存顺序」的输入顺序确定性裁剪：
 * 超过单工具字节上限或累计字节上限的工具跳过，达到数量上限即停止。
 */
export function trimMcpToolsForBudget(
  tools: McpToolDescriptor[],
  options?: { maxCount?: number; maxTotalBytes?: number }
): McpBudgetTrimResult {
  const maxCount = options?.maxCount ?? MCP_TOOLS_PER_ROUND_MAX
  const maxTotalBytes = options?.maxTotalBytes ?? MCP_TOOLS_TOTAL_BYTES_MAX
  const kept: McpToolDescriptor[] = []
  const dropped: Array<{ tool: McpToolDescriptor; reason: 'count' | 'bytes' }> = []
  let totalBytes = 0

  for (const tool of tools) {
    if (kept.length >= maxCount) {
      dropped.push({ tool, reason: 'count' })
      continue
    }
    const size = JSON.stringify(tool).length
    if (size > maxTotalBytes || totalBytes + size > maxTotalBytes) {
      dropped.push({ tool, reason: 'bytes' })
      continue
    }
    kept.push(tool)
    totalBytes += size
  }
  return { kept, dropped }
}

/**
 * MCP 工具确认策略：默认始终确认；仅当服务开启 `readonly-auto` 且工具同时满足
 * `readOnlyHint: true` 与 `destructiveHint: false` 时免确认（Server 注解只是提示，
 * 不能自动放宽默认策略）。
 */
export function mcpToolNeedsConfirmation(
  profile: Pick<McpServerProfile, 'toolConfirmPolicy'>,
  tool: Pick<McpToolDescriptor, 'annotations'>
): boolean {
  if (profile.toolConfirmPolicy !== 'readonly-auto') return true
  const annotations = tool.annotations
  return !(annotations?.readOnlyHint === true && annotations.destructiveHint !== true)
}

export type McpCallArgsValidationResult = { ok: true } | { ok: false; reason: string }

/**
 * tools/call 参数校验：必须是普通对象，深度 ≤20、序列化大小 ≤256 KiB。
 * （JSON Schema 的结构级校验由 Server 侧完成；这里做防滥用边界。）
 */
export function validateMcpCallArgs(
  input: unknown,
  _schema: Record<string, unknown>,
  options?: { maxDepth?: number; maxBytes?: number }
): McpCallArgsValidationResult {
  const maxDepth = options?.maxDepth ?? MCP_CALL_ARGS_MAX_DEPTH
  const maxBytes = options?.maxBytes ?? MCP_CALL_ARGS_MAX_BYTES
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: '参数必须是对象' }
  }
  if (jsonValueDepth(input) > maxDepth) {
    return { ok: false, reason: `参数深度超过 ${maxDepth}` }
  }
  try {
    if (JSON.stringify(input).length > maxBytes) {
      return { ok: false, reason: `参数大小超过 ${Math.round(maxBytes / 1024)} KiB` }
    }
  } catch {
    return { ok: false, reason: '参数无法序列化' }
  }
  return { ok: true }
}

function jsonValueDepth(value: unknown, depth = 0): number {
  if (Array.isArray(value)) {
    let max = depth + 1
    for (const item of value) max = Math.max(max, jsonValueDepth(item, depth + 1))
    return max
  }
  if (value && typeof value === 'object') {
    let max = depth + 1
    for (const item of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, jsonValueDepth(item, depth + 1))
    }
    return max
  }
  return depth
}

export const McpSaveProfilesPayloadSchema = z.object({
  servers: z.array(McpServerWriteInputSchema)
})

export const McpTestConnectionPayloadSchema = z.object({
  server: McpServerWriteInputSchema
})
