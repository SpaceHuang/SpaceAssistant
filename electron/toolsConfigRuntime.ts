import type { FeishuConfig } from '../src/shared/feishuTypes'
import type { WeChatConfig } from '../src/shared/wechatTypes'
import type { BrowserConfig, ShellConfig, ToolsConfig } from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'
import { BUILTIN_TOOL_DEFINITIONS } from '../src/shared/builtinToolDefinitions'
import { evaluateExposure, type ExposureResult } from './confirmation/exposure'
import { getSecurityAuditLog } from './confirmation/audit'
import type { AuditSink } from './confirmation/channels'
import type { ExecutionLane, PolicyRule } from '../src/shared/confirmation/types'

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
  rules?: PolicyRule[]
): typeof BUILTIN_TOOL_DEFINITIONS {
  let list = BUILTIN_TOOL_DEFINITIONS.filter((t) => isToolEnabledByConfig(t.name, cfg))
  if (!isShellToolEnabled(shellConfig, cfg)) {
    list = list.filter((t) => t.name !== 'run_shell')
  }
  if (!feishu?.enabled) {
    list = list.filter((t) => t.name !== 'run_lark_cli' && t.name !== 'read_feishu_attachment')
  }
  if (feishu?.integrationMode === 'mcp') {
    list = list.filter((t) => t.name !== 'run_lark_cli')
  }
  if (!wechat?.enabled) {
    list = list.filter((t) => t.name !== 'wechat_send' && t.name !== 'wechat_reply')
  }
  // wechat_send takes an arbitrary model-chosen userId; remote must only reach the
  // authenticated inbound sender via wechat_reply. This is unconditional — remote never
  // gets wechat_send regardless of remoteDenyOutbound. Desktop keeps wechat_send.
  if (remoteContext) {
    list = list.filter((t) => t.name !== 'wechat_send')
  }
  if (!browserConfig?.enabled) {
    list = list.filter((t) => t.name !== 'browser')
  }
  if (!remoteContext) {
    list = list.filter(
      (t) => t.name !== 'list_work_dirs' && t.name !== 'switch_work_dir' && t.name !== 'switch_session'
    )
  }
  // exposure 规则（主进程唯一评估者）：remote 链路按 lane 评估（如 im-no-wechat-send）；
  // desktop 链路不受该 exposure 规则影响。
  const lane = remoteContext
    ? remoteContext.source === 'feishu'
      ? 'feishu'
      : 'wechat'
    : 'desktop'
  list = list.filter((t) => {
    const r = evaluateExposure(rules ? { toolName: t.name, lane, rules } : { toolName: t.name, lane })
    if (!r.allowed) onExposureDeny?.(t.name, r)
    return r.allowed
  })
  return list
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
    confirmPolicy: 'always' as const
  } as const
  return filterBuiltinToolsForApi(cfg, feishu, browserConfig, remoteContext, shellConfig, wechat, onExposureDeny, rules).map(
    (t) => t.name
  )
}
