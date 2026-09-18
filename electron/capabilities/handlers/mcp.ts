import { z } from 'zod'
import type { CapabilityDescriptor } from '../types'
import { addMcpServer, type McpAddServerParams } from '../../mcp/mcpService'

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

export function createMcpCapabilities(): CapabilityDescriptor[] {
  return [mcpAddCapability]
}
