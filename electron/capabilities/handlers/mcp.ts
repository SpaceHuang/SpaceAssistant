import { z } from 'zod'
import type { CapabilityDescriptor } from '../types'
import { addMcpServer, type McpAddServerParams } from '../../mcp/mcpService'
import { listProfiles } from '../../mcp/mcpConfigStore'
import { getCachedTools } from '../../mcp/mcpToolRegistry'

/**
 * action.mcp.add（需求 §4.2，risk=act 需确认——确认矩阵 §6）：
 * 确认卡片展示完整 endpoint（toolkitCapabilityExtractor 摘要含参数），防诱导配置恶意端点。
 * 行为规范沿用前案 §5.2.2：endpoint 策略校验 → 保存 profile → OAuth discovery 结构化结论。
 * 本期不含 OAuth login——授权降级为设置页（需求 §1.4 Phase 3 恢复）。
 */
export const McpAddCapabilityParamsSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    transport: z.enum(['http', 'stdio']),
    endpoint: z.string().trim().min(1).max(2048).optional(),
    command: z.string().trim().min(1).max(1024).optional(),
    args: z.array(z.string().max(2048)).max(256).optional(),
    env: z.record(z.string().max(8192)).optional(),
    authMode: z.enum(['none', 'bearer-token', 'custom-header', 'oauth']).optional(),
    accessToken: z.string().min(1).max(8192).optional(),
    headerValue: z.string().min(1).max(8192).optional(),
    headerName: z.string().min(1).max(128).optional(),
    oauthClientId: z.string().min(1).max(256).optional(),
    oauthScopes: z.array(z.string().min(1).max(256)).max(32).optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.transport === 'http' && !v.endpoint) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'http 传输必须提供 endpoint', path: ['endpoint'] })
    }
    if (v.transport === 'stdio' && !v.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stdio 传输必须提供 command', path: ['command'] })
    }
  })

const mcpAddCapability: CapabilityDescriptor = {
  id: 'action.mcp.add',
  family: 'action',
  summary: '添加 MCP 连接：校验并保存服务配置（http/stdio），自动探测 OAuth 支持情况并返回结构化结论（支持 DCR / 需 Client ID / 仅 Bearer）',
  keywords: ['mcp', '添加服务', '连接服务', '接入', 'oauth', 'mcp服务器', 'add'],
  paramsSchema: McpAddCapabilityParamsSchema,
  paramsDoc:
    '{ "name": "服务名", "transport": "http"|"stdio", "endpoint": "URL（http 必填）", "command": "（stdio 必填）", "args": [], "env": { "KEY": "value" }, "authMode": "none"|"bearer-token"|"custom-header"|"oauth"（缺省 http=oauth，stdio=none）, "accessToken": "（bearer-token）", "oauthClientId": "（可选）", "oauthScopes": [] }',
  returnsDoc:
    '{ ok, serverId, conclusion: { kind: "oauth-dcr"|"oauth-client-id"|"bearer-only"|"none", message }, guide }（不含任何凭据明文）',
  risk: 'act',
  notes: ['需用户确认后执行', '授权步骤本期需用户在设置页完成', '凭据加密存储，结果只出存在性旗标'],
  handler: async (rawParams, ctx) => {
    const db = ctx.appDatabase as import('../../database').AppDatabase | undefined
    if (!db) {
      throw new Error('MCP 配置不可用：缺少数据库上下文')
    }
    return addMcpServer(db, rawParams as McpAddServerParams)
  }
}

/**
 * action.mcp.list（risk=read 免确认）：服务配置概览自诊断——模型在会话内可查
 * 「服务已连接但白名单为空（0 工具注入）」等状态，避免凭 toolkit_find 搜不到就误报未加载。
 * 只出存在性旗标与计数；lastError 仅出结构化 code（message 可能含 endpoint/主机名或
 * 服务端可控文本，属提示注入面，只留给面向人的设置页诊断通道）。
 */
const mcpListCapability: CapabilityDescriptor = {
  id: 'action.mcp.list',
  family: 'action',
  summary: '列出已配置的 MCP 服务：启用状态、连接状态、发现/启用工具数；用于自查服务是否可用',
  keywords: ['mcp', '服务列表', 'mcp状态', '连接状态', '已配置服务', 'servers', 'list'],
  paramsSchema: z.object({}).strict(),
  paramsDoc: '{ }；无参数',
  returnsDoc:
    '{ servers: [{ id, name, enabled, transport, status, authMode, secretPresent, discoveredToolCount, enabledToolCount, enabledToolNames, lastError?: { code }, hint? }]}；hint 非空表示服务已发现工具但未启用任何一个（会话中不可用）',
  risk: 'read',
  notes: ['只读，不出 endpoint、不出凭据、lastError 仅含 code', 'hint 非空时需引导用户到设置页勾选工具'],
  handler: async (_rawParams, ctx) => {
    const db = ctx.appDatabase as import('../../database').AppDatabase | undefined
    if (!db) {
      throw new Error('MCP 配置不可用：缺少数据库上下文')
    }
    const servers = listProfiles(db).map((profile) => {
      const cache = getCachedTools(db, profile.id)
      const discoveredToolCount = cache?.tools.length ?? 0
      const enabledToolCount = profile.enabledToolNames.length
      const base = {
        id: profile.id,
        name: profile.name,
        enabled: profile.enabled,
        transport: profile.transport,
        status: profile.status,
        authMode: profile.auth.mode,
        secretPresent: profile.auth.secretPresent,
        discoveredToolCount,
        enabledToolCount,
        enabledToolNames: [...profile.enabledToolNames],
        ...(profile.lastError ? { lastError: { code: profile.lastError.code } } : {})
      }
      if (profile.enabled && discoveredToolCount > 0 && enabledToolCount === 0) {
        return {
          ...base,
          hint: `该服务已连接并发现 ${discoveredToolCount} 个工具，但尚未启用任何一个——会话中不可用；请引导用户到设置页 → MCP 服务中勾选工具`
        }
      }
      return base
    })
    return { servers }
  }
}

export function createMcpCapabilities(): CapabilityDescriptor[] {
  return [mcpAddCapability, mcpListCapability]
}
