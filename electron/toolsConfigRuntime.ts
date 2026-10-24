import type { FeishuConfig } from '../src/shared/feishuTypes'
import type { WeChatConfig } from '../src/shared/wechatTypes'
import type { BrowserConfig, ShellConfig, ToolsConfig } from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'
import { BUILTIN_TOOL_DEFINITIONS } from '../src/shared/builtinToolDefinitions'
import { evaluateExposure, issueExposureApprovalPermit, type ExposureResult } from './confirmation/exposure'
import { getSecurityAuditLog } from './confirmation/audit'
import type { AuditSink } from './confirmation/channels'
import type { ExecutionLane, PolicyRule } from '../src/shared/confirmation/types'
import { buildTerminalToolContract, type TerminalProfileSnapshot } from './shell/terminalToolContract'

/** Automation API schema: every Shell invocation must identify its approved per-command cwd. */
export function requireAutomationShellWorkingDirectory<T extends readonly unknown[]>(tools: T): T {
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool
    const entry = tool as { name?: unknown; description?: unknown; input_schema?: unknown; [key: string]: unknown }
    if (entry.name !== 'run_shell' || typeof entry.description !== 'string' || !entry.input_schema || typeof entry.input_schema !== 'object' || Array.isArray(entry.input_schema)) return tool
    const schema = entry.input_schema as { required?: unknown; [key: string]: unknown }
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
    return {
      ...entry,
      description: `${entry.description} 定时任务必须在 workingDirectory 中提供本条命令已获批的工作目录。`,
      input_schema: { ...schema, required: [...new Set([...required, 'workingDirectory'])] }
    }
  }) as unknown as T
}

export function isShellToolEnabled(shellConfig: ShellConfig | null | undefined, cfg: ToolsConfig): boolean {
  if (!shellConfig?.enabled) return false
  return isToolEnabledByConfig('run_shell', cfg)
}

export function isBuiltinToolName(name: string): boolean {
  return BUILTIN_TOOL_DEFINITIONS.some((t) => t.name === name)
}

export function isToolEnabledByConfig(name: string, cfg: ToolsConfig): boolean {
  if (!cfg.enabled) return false
  if (cfg.deniedTools.includes(name)) return false
  if (cfg.allowedTools.length > 0 && !cfg.allowedTools.includes(name)) return false
  return isBuiltinToolName(name)
}

export function filterBuiltinToolsForApi(
  cfg: ToolsConfig,
  feishu?: FeishuConfig | null,
  browserConfig?: BrowserConfig | null,
  remoteContext?: RemoteContext | null,
  shellConfig?: ShellConfig | null,
  wechat?: WeChatConfig | null,
  // exposure 规则拒绝回调（策略过滤落审计用，普通开关不记）
  onExposureDeny?: (toolName: string, result: ExposureResult) => void,
  // 测试可注入规则集；默认 DEFAULT_POLICY_RULES
  rules?: PolicyRule[],
  // 可选的请求级 profile snapshot；存在时只重写 run_shell description，不改静态工具 schema。
  terminalSnapshot?: TerminalProfileSnapshot,
  skipExposureEvaluation = false
): typeof BUILTIN_TOOL_DEFINITIONS {
  let list = BUILTIN_TOOL_DEFINITIONS.filter((t) => isToolEnabledByConfig(t.name, cfg))
  if (!isShellToolEnabled(shellConfig, cfg)) {
    list = list.filter((t) => t.name !== 'run_shell')
  }
  if (!feishu?.enabled) {
    list = list.filter((t) => t.name !== 'run_lark_cli' && t.name !== 'read_feishu_attachment')
  }
  const feishuAttachments = remoteContext?.source === 'feishu' ? remoteContext.feishuAttachments ?? [] : []
  if (feishuAttachments.length === 0) {
    list = list.filter((t) => t.name !== 'read_feishu_attachment')
  } else {
    const attachmentIds = feishuAttachments.map((attachment) => attachment.id)
    const attachmentNames = feishuAttachments.map((attachment) => `${attachment.id}: ${attachment.fileName ?? '飞书附件'}`).join('；')
    list = list.map((tool) => {
      if (tool.name !== 'read_feishu_attachment') return tool
      const schema = tool.input_schema as { type: 'object'; properties: Record<string, unknown>; required?: string[] }
      return {
        ...tool,
        input_schema: {
          ...schema,
          properties: {
            ...schema.properties,
            attachmentId: { type: 'string', enum: attachmentIds, description: `本次消息附件：${attachmentNames}` }
          }
        }
      } as typeof tool
    })
  }
  if (feishu?.integrationMode === 'mcp') {
    list = list.filter((t) => t.name !== 'run_lark_cli')
  }
  if (!wechat?.enabled) {
    list = list.filter((t) => t.name !== 'wechat_send' && t.name !== 'wechat_reply')
  }
  if (!browserConfig?.enabled) {
    list = list.filter((t) => t.name !== 'browser')
  }
  if (!remoteContext) {
    list = list.filter(
      (t) => t.name !== 'list_work_dirs' && t.name !== 'switch_work_dir' && t.name !== 'switch_session'
    )
  }
  // toolkit 网关初期仅桌面 lane（docs/requirement/agent-toolkit-capability-gateway-requirement.md §2 lane 隔离）
  if (remoteContext) {
    list = list.filter((t) => t.name !== 'toolkit.find' && t.name !== 'toolkit.call')
  }
  // tool_search 的结果仍受本回合 MCP 快照与统一 trim 限制；IM 可用它搜索已准入工具。
  // exposure 规则（主进程唯一评估者）：remote 链路按 lane 评估（如 im-no-wechat-send）；
  // desktop 链路不受该 exposure 规则影响。
  const lane = remoteContext
    ? remoteContext.source === 'feishu'
      ? 'feishu'
      : 'wechat'
    : 'desktop'
  if (!skipExposureEvaluation) list = list.filter((t) => {
    const r = evaluateExposure(rules ? { toolName: t.name, lane, rules } : { toolName: t.name, lane })
    if (!r.allowed) onExposureDeny?.(t.name, r)
    return r.allowed
  })
  if (!terminalSnapshot) return list
  const contract = buildTerminalToolContract(terminalSnapshot)
  return list.map((tool) => tool.name === 'run_shell' ? { ...tool, description: contract.description } : tool)
}

/** Async production path: do not advertise an ask-gated object until the local owner approves this exact target. */
export async function filterBuiltinToolsForApiWithApproval(args: {
  cfg: ToolsConfig
  feishu?: FeishuConfig | null
  browserConfig?: BrowserConfig | null
  remoteContext?: RemoteContext | null
  shellConfig?: ShellConfig | null
  wechat?: WeChatConfig | null
  audit?: AuditSink
  rules?: PolicyRule[]
  resolveRules?: () => PolicyRule[]
  resolveAuthorizationVersion?: () => string
  terminalSnapshot?: TerminalProfileSnapshot
  requestApproval: (request: { lane: ExecutionLane; toolName: string; ruleId: string }) => Promise<boolean>
}): Promise<typeof BUILTIN_TOOL_DEFINITIONS> {
  const lane: ExecutionLane = args.remoteContext ? args.remoteContext.source === 'feishu' ? 'feishu' : 'wechat' : 'desktop'
  const candidates = filterBuiltinToolsForApi(args.cfg, args.feishu, args.browserConfig, args.remoteContext,
    args.shellConfig, args.wechat, undefined, args.rules, args.terminalSnapshot, true)
  const sink = args.audit ?? getSecurityAuditLog()
  const allowed = new Set<string>()
  for (const tool of candidates) {
    let currentRules = args.resolveRules?.() ?? args.rules
    const decision = evaluateExposure({ toolName: tool.name, lane, rules: currentRules })
    if (decision.allowed) {
      allowed.add(tool.name)
      continue
    }
    if (decision.action === 'deny') {
      sink.record({ ts: Date.now(), event: 'policy.deny-exposure', lane, sessionId: '', toolName: tool.name,
        decision: 'deny', ruleId: decision.ruleId, reason: decision.reason, actor: 'system' })
      continue
    }
    if (decision.action !== 'ask' || !decision.ruleId) continue
    let pending = decision
    for (let attempt = 0; attempt < 4 && pending.action === 'ask' && pending.ruleId; attempt += 1) {
      let approved = false
      const approvedRules = JSON.stringify(currentRules ?? [])
      const approvedVersion = args.resolveAuthorizationVersion?.()
      try { approved = await args.requestApproval({ lane, toolName: tool.name, ruleId: pending.ruleId }) } catch { approved = false }
      // Policy phase: an exposure prompt answer is valid only against the snapshot/version it opened on.
      currentRules = args.resolveRules?.() ?? args.rules
      const currentVersion = args.resolveAuthorizationVersion?.()
      if (JSON.stringify(currentRules ?? []) !== approvedRules || approvedVersion !== currentVersion) {
        pending = evaluateExposure({ toolName: tool.name, lane, rules: currentRules })
        if (pending.allowed) { allowed.add(tool.name); break }
        if (pending.action === 'deny' || pending.action !== 'ask' || !pending.ruleId) break
        continue
      }
      if (!approved) break
      const permit = issueExposureApprovalPermit({ ruleId: pending.ruleId, toolName: tool.name, lane })
      if (evaluateExposure({ toolName: tool.name, lane, rules: currentRules, approvedExposure: permit }).allowed) allowed.add(tool.name)
      break
    }
  }
  return candidates.filter((tool) => allowed.has(tool.name))
}

/**
 * exposure 清单求值（主进程唯一评估者，供 IPC 下发渲染端）：
 * 按链路(desktop/wechat/feishu)返回可见工具名清单（合并 exposure 规则 + 开关/deniedTools/allow）。
 * 因策略规则（而非普通开关）被过滤的条目落 `policy.deny-exposure` 审计事件（§5.6 发射点表）。
 */
export function exposedToolNamesForLane(
  lane: ExecutionLane,
  cfg: ToolsConfig,
  feishu?: FeishuConfig | null,
  browserConfig?: BrowserConfig | null,
  shellConfig?: ShellConfig | null,
  wechat?: WeChatConfig | null,
  audit?: AuditSink,
  rules?: PolicyRule[]
): string[] {
  const sink = audit ?? getSecurityAuditLog()
  const onExposureDeny = (toolName: string, result: ExposureResult): void => {
    // 仅策略规则过滤落审计（开关/deniedTools 属普通配置，不记）；无会话上下文，sessionId 置空。
    sink.record({
      ts: Date.now(),
      event: 'policy.deny-exposure',
      lane,
      sessionId: '',
      toolName,
      decision: 'deny',
      ruleId: result.ruleId,
      reason: result.reason,
      actor: 'system'
    })
  }
  if (lane === 'desktop') {
    return filterBuiltinToolsForApi(cfg, feishu, browserConfig, null, shellConfig, wechat, onExposureDeny, rules).map(
      (t) => t.name
    )
  }
  const remoteContext = {
    source: lane === 'feishu' ? ('feishu' as const) : ('wechat' as const),
    messageId: 'exposure',
  } as const
  return filterBuiltinToolsForApi(cfg, feishu, browserConfig, remoteContext, shellConfig, wechat, onExposureDeny, rules).map(
    (t) => t.name
  )
}
