import type { AppDatabase } from '../database'
import { deleteConfigValue, getConfigValue, setConfigValue } from '../database'
import {
  MCP_TOOL_SCHEMA_MAX_BYTES,
  MCP_TOOL_SCHEMA_MAX_DEPTH,
  deriveUniqueMappedToolName,
  generateMappedToolName,
  parseMcpToolCache,
  trimMcpToolsForBudget,
  type McpServerProfile,
  type McpToolAnnotations,
  type McpToolCacheEntry,
  type McpToolDescriptor
} from '../../src/shared/mcpTypes'
import type { McpSession } from './mcpConnectionManager'
import { listProfiles } from './mcpConfigStore'

/**
 * MCP 工具注册表：tools/list 校验、映射名生成（含全局查重，评审 A6）、缓存写入、
 * list_changed 过期标记。按请求快照导出模型工具定义在 P0-B 的 buildSnapshotTools。
 */

export function mcpToolCacheKey(serverId: string): string {
  return `config.mcpToolCache.${serverId}`
}

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > MCP_TOOL_SCHEMA_MAX_DEPTH) return depth
  if (Array.isArray(value)) {
    let max = depth + 1
    for (const item of value) max = Math.max(max, jsonDepth(item, depth + 1))
    return max
  }
  if (value && typeof value === 'object') {
    let max = depth + 1
    for (const item of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, jsonDepth(item, depth + 1))
    }
    return max
  }
  return depth
}

export type McpToolSchemaValidationResult =
  | {
      ok: true
      tool: {
        name: string
        description: string
        inputSchema: Record<string, unknown>
        annotations?: McpToolAnnotations
      }
    }
  | { ok: false; reason: string }

export function validateMcpToolSchema(input: unknown): McpToolSchemaValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: '工具不是对象' }
  }
  const t = input as Record<string, unknown>
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.trim().length > 256) {
    return { ok: false, reason: '工具名非法或超长' }
  }
  const description = typeof t.description === 'string' ? t.description.slice(0, 4000) : ''

  let inputSchema: Record<string, unknown>
  if (t.inputSchema === undefined || t.inputSchema === null) {
    inputSchema = {}
  } else if (typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)) {
    inputSchema = t.inputSchema as Record<string, unknown>
  } else {
    return { ok: false, reason: 'inputSchema 必须是对象' }
  }

  if (jsonDepth(inputSchema) > MCP_TOOL_SCHEMA_MAX_DEPTH) {
    return { ok: false, reason: `inputSchema 深度超过 ${MCP_TOOL_SCHEMA_MAX_DEPTH}` }
  }
  try {
    if (JSON.stringify(inputSchema).length > MCP_TOOL_SCHEMA_MAX_BYTES) {
      return { ok: false, reason: `inputSchema 超过 ${Math.round(MCP_TOOL_SCHEMA_MAX_BYTES / 1024)} KiB` }
    }
  } catch {
    return { ok: false, reason: 'inputSchema 无法序列化' }
  }

  let annotations: McpToolAnnotations | undefined
  if (t.annotations && typeof t.annotations === 'object' && !Array.isArray(t.annotations)) {
    const a = t.annotations as Record<string, unknown>
    annotations = {
      ...(typeof a.readOnlyHint === 'boolean' ? { readOnlyHint: a.readOnlyHint } : {}),
      ...(typeof a.destructiveHint === 'boolean' ? { destructiveHint: a.destructiveHint } : {}),
      ...(typeof a.idempotentHint === 'boolean' ? { idempotentHint: a.idempotentHint } : {}),
      ...(typeof a.openWorldHint === 'boolean' ? { openWorldHint: a.openWorldHint } : {})
    }
  }

  return {
    ok: true,
    tool: {
      name: t.name.trim(),
      description,
      inputSchema,
      ...(annotations ? { annotations } : {})
    }
  }
}

export function buildMappedToolDescriptors(
  serverId: string,
  serverName: string,
  rawTools: unknown[],
  options?: { usedMappedNames?: ReadonlySet<string> }
): {
  descriptors: McpToolDescriptor[]
  skipped: Array<{ name: string; reason: string }>
} {
  const used = new Set<string>(options?.usedMappedNames ?? [])
  const descriptors: McpToolDescriptor[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  const now = new Date().toISOString()

  for (const raw of rawTools) {
    const rawName =
      raw && typeof raw === 'object' && 'name' in raw && typeof (raw as { name?: unknown }).name === 'string'
        ? ((raw as { name: string }).name ?? '')
        : ''
    const validation = validateMcpToolSchema(raw)
    if (!validation.ok) {
      skipped.push({ name: rawName || '<unknown>', reason: validation.reason })
      continue
    }
    const base = generateMappedToolName({ serverId, serverName, toolName: validation.tool.name })
    const mappedName = deriveUniqueMappedToolName(base, used)
    used.add(mappedName)
    descriptors.push({
      serverId,
      originalName: validation.tool.name,
      mappedName,
      description: validation.tool.description,
      inputSchema: validation.tool.inputSchema,
      ...(validation.tool.annotations ? { annotations: validation.tool.annotations } : {}),
      discoveredAt: now
    })
  }
  return { descriptors, skipped }
}

export function getCachedTools(db: AppDatabase, serverId: string): McpToolCacheEntry | null {
  return parseMcpToolCache(getConfigValue(db, mcpToolCacheKey(serverId)))
}

export function cacheTools(db: AppDatabase, serverId: string, entry: McpToolCacheEntry): void {
  setConfigValue(db, mcpToolCacheKey(serverId), JSON.stringify(entry))
}

export function clearCachedTools(db: AppDatabase, serverId: string): void {
  deleteConfigValue(db, mcpToolCacheKey(serverId))
}

/** notifications/tools/list_changed：标记缓存过期，后台刷新期间继续使用上一次列表。 */
export function markToolsStale(db: AppDatabase, serverId: string): void {
  const entry = getCachedTools(db, serverId)
  if (!entry) return
  cacheTools(db, serverId, { ...entry, stale: true })
}

export type McpToolDiscoveryResult =
  | {
      ok: true
      tools: McpToolDescriptor[]
      protocolVersion: string
      serverName: string
      skipped: Array<{ name: string; reason: string }>
    }
  | { ok: false; code: string; message: string }

export async function discoverToolsFromSession(
  db: AppDatabase,
  profile: McpServerProfile,
  session: McpSession
): Promise<McpToolDiscoveryResult> {
  try {
    const toolsResult = await session.client.listTools()
    const used = new Set<string>()
    const cached = getCachedTools(db, profile.id)
    if (cached) {
      for (const tool of cached.tools) used.add(tool.mappedName)
    }
    const { descriptors, skipped } = buildMappedToolDescriptors(
      profile.id,
      profile.name,
      toolsResult.tools as unknown[],
      { usedMappedNames: used }
    )
    cacheTools(db, profile.id, {
      tools: descriptors,
      protocolVersion: session.protocolVersion,
      discoveredAt: new Date().toISOString(),
      ...(skipped.length > 0 ? { skippedCount: skipped.length } : {})
    })
    return {
      ok: true,
      tools: descriptors,
      protocolVersion: session.protocolVersion,
      serverName: session.info.name,
      skipped
    }
  } catch (error) {
    return {
      ok: false,
      code: 'tools-list-failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export type McpToolSnapshotEntry = {
  serverId: string
  serverName: string
  originalName: string
  mappedName: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: McpToolAnnotations
}

export type McpToolSnapshot = {
  /** mappedName → 条目（请求级快照，随请求生命周期）。 */
  entries: Map<string, McpToolSnapshotEntry>
  /** 因上下文预算未注入的工具（供设置页展示）。 */
  budgetDropped: Array<{ mappedName: string; reason: 'count' | 'bytes' }>
}

/**
 * 构建请求级 MCP 工具快照：
 * - 远程 IM 会话（remoteContext 存在）一律不注入（需求 §4.6）。
 * - 仅启用且白名单非空的服务注入；按服务配置数组顺序 → enabledToolNames 保存顺序确定性排列。
 * - 预算：每轮最多 64 个 / 累计 ≤96 KiB，超限按顺序裁剪并记录。
 */
export function buildSnapshotTools(
  profiles: McpServerProfile[],
  caches: ReadonlyMap<string, McpToolCacheEntry>,
  options?: { remoteContext?: boolean; maxCount?: number; maxTotalBytes?: number }
): McpToolSnapshot {
  const snapshot: McpToolSnapshot = { entries: new Map(), budgetDropped: [] }
  if (options?.remoteContext) return snapshot

  const ordered: McpToolDescriptor[] = []
  for (const profile of profiles) {
    if (!profile.enabled) continue
    if (profile.enabledToolNames.length === 0) continue
    const cache = caches.get(profile.id)
    if (!cache) continue
    const byOriginal = new Map(cache.tools.map((t) => [t.originalName, t]))
    for (const originalName of profile.enabledToolNames) {
      const tool = byOriginal.get(originalName)
      if (tool) ordered.push(tool)
    }
  }

  const trimmed = trimMcpToolsForBudget(ordered, {
    maxCount: options?.maxCount,
    maxTotalBytes: options?.maxTotalBytes
  })
  for (const tool of trimmed.kept) {
    const profile = profiles.find((p) => p.id === tool.serverId)
    snapshot.entries.set(tool.mappedName, {
      serverId: tool.serverId,
      serverName: profile?.name ?? tool.serverId,
      originalName: tool.originalName,
      mappedName: tool.mappedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {})
    })
  }
  snapshot.budgetDropped = trimmed.dropped.map((d) => ({
    mappedName: d.tool.mappedName,
    reason: d.reason
  }))
  return snapshot
}

/** 快照条目 → Anthropic Tool[]，描述加来源前缀。 */
export function snapshotEntriesToAnthropicTools(
  entries: Iterable<McpToolSnapshotEntry>
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return [...entries].map((entry) => ({
    name: entry.mappedName,
    description: `外部 MCP 服务「${entry.serverName}」提供的工具${
      entry.description ? `：${entry.description.slice(0, 3500)}` : ''
    }`,
    input_schema: entry.inputSchema
  }))
}

/** 从 DB 构建当前快照（toolChatLoop 用，仅桌面会话注入）。 */
export function buildSnapshotFromDb(
  db: AppDatabase,
  options?: { remoteContext?: boolean }
): McpToolSnapshot {
  const profiles = listProfiles(db)
  const caches = new Map<string, McpToolCacheEntry>()
  for (const profile of profiles) {
    const cache = getCachedTools(db, profile.id)
    if (cache) caches.set(profile.id, cache)
  }
  return buildSnapshotTools(profiles, caches, { remoteContext: options?.remoteContext })
}
