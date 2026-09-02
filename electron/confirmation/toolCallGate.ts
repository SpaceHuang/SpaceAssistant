import { decide } from '../../src/shared/policy/policyEngine'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { getBuiltinToolMetadata } from '../../src/shared/builtinToolMetadata'
import type {
  AutoApproveFallback,
  BrowserConfig,
  FeishuConfig,
  ShellConfig,
  ToolsConfig,
  WeChatConfig
} from '../../src/shared/domainTypes'
import type {
  AuditSink
} from './channels'
import type {
  ContentFacts,
  Decision,
  DecisionCacheView,
  EnvFacts,
  ExecutionContext,
  ExecutionLane,
  OriginInfo,
  PolicyEngineDeps
} from '../../src/shared/confirmation/types'
import { runExtractors } from './extractors/runExtractors'
import { extractScriptSignals } from './extractors/scriptAnalysisExtractor'
import { analyzeScriptContent, type ScriptAnalysisResult } from '../shell/scriptContentSecurity'
import { precheckRunShellTool } from '../shell/shellToolLoopHelpers'
import { getBuiltinSensitivePrefixes } from '../shell/shellSensitivePaths'
import { evaluateFileToolAutoApproval } from '../tools/writeFileAutoApproval'
import { extractHostname } from '../browser/urlSecurity'
import type { ActDangerAssessment } from '../browser/browserActionPolicy'
import { classifyLarkCliImpact } from '../feishu/larkCliImpactPolicy'
import type { McpToolSnapshotEntry } from '../mcp/mcpToolRegistry'
import type { RemoteContext } from '../tools/types'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { checkRemoteTaskBudget, type RemoteTaskBudgetState } from '../remote/remoteTaskBudget'
import {
  isRemoteSecurityMigrationComplete,
  shouldSkipRemoteBrowserActConfirm
} from '../remote/remoteToolPolicy'
import { AuditedDecisionCache } from './auditedDecisionCache'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { getSecurityAuditLog } from './audit'
import { loadEffectivePolicyRules } from './policyRulesRuntime'
import type { ShellAnalysisResult } from '../shell/shellTypes'
import type { ShellSecurityHints } from '../../src/shared/domainTypes'

const EMPTY_CACHE: DecisionCacheView = { lookup: () => null }

/** 出站写工具判定（等价现 toolChatLoop.isOutboundWriteTool：未知/非读 fail-closed 计写）。 */
export function isOutboundWriteTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName === 'wechat_send' || toolName === 'wechat_reply') return true
  if (toolName !== 'run_lark_cli') return false
  return classifyLarkCliImpact(toolInput.args).impact !== 'read'
}

export interface ToolCallGateArgs {
  toolName: string
  toolInput: Record<string, unknown>
  sessionId: string
  workDir: string
  userDataDir: string
  remoteContext?: RemoteContext
  toolsConfig: ToolsConfig
  shellConfig?: ShellConfig | null
  browserConfig?: BrowserConfig | null
  feishuConfig?: FeishuConfig
  wechatConfig?: WeChatConfig
  appDb?: AppDatabase
  remoteBudgetState?: RemoteTaskBudgetState | null
  /** 浏览器 act 的危险评估结论（由执行链路先行评估注入）。 */
  dangerAssessment?: ActDangerAssessment | null
  /** 浏览器 act 的当前页 URL（peekCurrentUrl）。 */
  currentPageUrl?: string
  /** 请求级 MCP 快照条目（映射工具名 → 条目）；非 MCP 工具不传。 */
  mcpEntry?: McpToolSnapshotEntry
  audit?: AuditSink
  /** 测试注入：替代 shell 预检 / 文件自动审批（生产默认真实实现）。 */
  runShellPrecheck?: typeof precheckRunShellTool
  fileAutoApproval?: typeof evaluateFileToolAutoApproval
}

export interface ToolCallGateResult {
  decision: Decision
  facts: ContentFacts
  /** run_shell 预检通过时的结构化结果（供日志/确认卡片 hints）。 */
  shellPrecheck?: { analysis: ShellAnalysisResult; skipConfirm: boolean; hints: ShellSecurityHints }
  /** run_shell 预检拒绝（validator 性质，gate 前置短路，不进引擎）。 */
  shellPrecheckDeny?: {
    error: string
    auditReason: string
    validatorId?: string
    denyType?: 'strong' | 'weak'
  }
  /** 出站写预算耗尽：主循环按此映射为预算三选暂停流程。 */
  budgetPause?: { message: string; reason: string }
  /** 桌面写/编辑自动审批回退原因（确认卡片展示）。 */
  autoApproveFallback?: AutoApproveFallback
  /** MCP 条目回传（确认卡片载荷）。 */
  mcpEntry?: McpToolSnapshotEntry
  /** run_script 原始分析（拒绝消息桥接 / 日志 patterns）。 */
  rawScriptAnalysis?: ScriptAnalysisResult
}

function laneOf(remoteContext?: RemoteContext): ExecutionLane {
  if (!remoteContext) return 'desktop'
  return remoteContext.source === 'feishu' ? 'feishu' : 'wechat'
}

/**
 * §5.5 直线流程的门控段：组装 ExecutionContext → 事实提取 → decide() → 落 policy.decision 审计。
 * 通道确认、记账（recordOutboundWrite / grant reserve）与拒绝消息映射仍由主循环承担。
 */
export async function evaluateToolCallGate(args: ToolCallGateArgs): Promise<ToolCallGateResult> {
  const lane = laneOf(args.remoteContext)
  const origin: OriginInfo = { kind: 'direct-owner' }
  const channelConfig = args.remoteContext
    ? args.remoteContext.source === 'feishu'
      ? args.feishuConfig
      : args.wechatConfig
    : undefined
  const audit = args.audit ?? getSecurityAuditLog()
  const result: ToolCallGateResult = {
    decision: undefined as unknown as Decision,
    facts: undefined as unknown as ContentFacts
  }

  // ===== 前置 validator：run_shell 预检（deny 短路，不进引擎）=====
  let shellSkipConfirm = false
  if (args.toolName === 'run_shell') {
    const precheck = await (args.runShellPrecheck ?? precheckRunShellTool)({
      command: typeof args.toolInput.command === 'string' ? args.toolInput.command : '',
      workDir: args.workDir,
      userDataDir: args.userDataDir,
      shellConfig: args.shellConfig,
      appDb: args.appDb
    })
    if (!precheck.ok) {
      result.shellPrecheckDeny = {
        error: precheck.error,
        auditReason: precheck.auditReason,
        ...(precheck.validatorId ? { validatorId: precheck.validatorId } : {}),
        ...(precheck.denyType ? { denyType: precheck.denyType } : {})
      }
      result.decision = { type: 'deny', ruleId: 'shell-precheck-deny', reason: precheck.error }
      result.facts = {
        toolName: args.toolName,
        actionClass: 'execute',
        baseRiskLevel: 'high',
        signals: [],
        summary: { text: args.toolName }
      }
      return result
    }
    result.shellPrecheck = {
      analysis: precheck.analysis,
      skipConfirm: precheck.skipConfirm,
      hints: precheck.hints
    }
    shellSkipConfirm = precheck.skipConfirm
  }

  // ===== 生效规则集（套餐/覆盖，§4 第 1 区）：默认 standard 返回 DEFAULT_POLICY_RULES 引用 =====
  // 提前加载：桌面写/编辑自动审批的预计算条件要看 desktop-auto-approve 的生效动作
  const rules = args.appDb ? loadEffectivePolicyRules(args.appDb, lane) : DEFAULT_POLICY_RULES

  // ===== 桌面写/编辑自动审批（预计算，评估器闭包消费）=====
  // 生效条件：desktop-auto-approve 动作为 auto-evaluator；默认规则带 confirmMode=auto 门控，
  // 覆盖后（门控剥离，见 applyCustom）由规则动作直接决定——确认模式已并入规则列表统一受套餐管理
  const autoApproveRule = rules.find((r) => r.id === 'desktop-auto-approve')
  const autoApproveActive =
    autoApproveRule?.action === 'auto-evaluator' &&
    (autoApproveRule.configRequires ? args.toolsConfig.confirmMode === 'auto' : true)
  let fileAutoApprove: boolean | undefined
  if (
    !args.remoteContext &&
    (args.toolName === 'write_file' || args.toolName === 'edit_file') &&
    autoApproveActive
  ) {
    const autoEval = await (args.fileAutoApproval ?? evaluateFileToolAutoApproval)({
      workDir: args.workDir,
      userDataDir: args.userDataDir,
      toolsConfig: args.toolsConfig,
      shellConfig: args.shellConfig,
      toolName: args.toolName,
      input: args.toolInput
    })
    fileAutoApprove = autoEval.approve
    if (!autoEval.approve) {
      result.autoApproveFallback = { reason: autoEval.reason, reasonCode: autoEval.reasonCode }
    }
  }

  // ===== 环境事实 =====
  const env: EnvFacts = {
    os: process.platform,
    workDir: args.workDir,
    sensitivePaths: getBuiltinSensitivePrefixes(args.userDataDir)
  }
  if (args.toolName === 'browser' && args.toolInput.action === 'act') {
    // 高危或会话信任关闭时不注入 currentHost（不派生缓存键、不消费域名信任），等价现状。
    const dangerous = args.dangerAssessment?.dangerous === true
    const host =
      !dangerous && args.browserConfig?.actSessionTrustEnabled !== false && args.currentPageUrl
        ? extractHostname(args.currentPageUrl)
        : null
    env.browserAct = {
      ...(host ? { currentHost: host } : {}),
      ...(dangerous ? { dangerous: true } : {})
    }
  }

  // ===== 事实提取 =====
  let facts: ContentFacts
  if (args.mcpEntry) {
    // MCP：事实提取为纯信号——总是产 mcp-tool（落 mcp-tool-ask 默认确认，会话信任经缓存命中放行）；
    // 注解安全（server 声明 readOnlyHint:true 且 destructiveHint≠true）时额外产 mcp-readonly，
    // 由 mcp-readonly-allow 规则放行（strict 套餐自动上调为 ask）。actionClass：注解安全 → read，否则 write。
    const annotationsSafe =
      args.mcpEntry.annotations?.readOnlyHint === true && args.mcpEntry.annotations.destructiveHint !== true
    facts = {
      toolName: args.toolName,
      actionClass: annotationsSafe ? 'read' : 'write',
      baseRiskLevel: 'medium',
      signals: [
        {
          kind: 'mcp-tool',
          serverId: args.mcpEntry.serverId,
          toolName: args.mcpEntry.originalName
        },
        ...(annotationsSafe
          ? [
              {
                kind: 'mcp-readonly',
                serverId: args.mcpEntry.serverId,
                toolName: args.mcpEntry.originalName
              } as const
            ]
          : [])
      ],
      summary: { text: `MCP ${args.mcpEntry.serverName}/${args.mcpEntry.originalName}` }
    }
    result.mcpEntry = args.mcpEntry
  } else if (args.toolName === 'run_script') {
    const code = typeof args.toolInput.code === 'string' ? args.toolInput.code : ''
    const { signals, summary } = extractScriptSignals(code, env)
    facts = {
      toolName: 'run_script',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals,
      summary
    }
    result.rawScriptAnalysis = analyzeScriptContent(code, { remote: lane !== 'desktop' })
  } else {
    const descriptor = getBuiltinToolMetadata(args.toolName)
    if (descriptor) {
      facts = runExtractors(descriptor, args.toolInput, env)
    } else {
      // 未注册工具：信息不足，默认表兜底（execute/write → ask）
      facts = {
        toolName: args.toolName,
        actionClass: 'execute',
        baseRiskLevel: 'medium',
        signals: [{ kind: 'extraction-failed', reason: '未注册的工具元数据' }],
        summary: { text: args.toolName }
      }
    }
  }

  // ===== 执行上下文（预算/授权只读 peek；记账留主循环）=====
  const context: ExecutionContext = { lane, origin, sessionId: args.sessionId }
  let outboundBudgetMessage: { message: string; reason: string } | undefined
  if (args.remoteBudgetState && isOutboundWriteTool(args.toolName, args.toolInput)) {
    const check = checkRemoteTaskBudget(args.remoteBudgetState, 'outbound_write')
    context.outboundWriteBudgetRemaining = check.ok ? 1 : 0
    if (!check.ok) {
      outboundBudgetMessage = {
        message: `${check.message}（继续 / 回桌面 / 停止）`,
        reason: check.reason
      }
    }
  }
  // ===== 配置袋（规则 configRequires/askUnless 消费）=====
  const config: Record<string, unknown> = {
    confirmMode: args.toolsConfig.confirmMode,
    deniedTools: args.toolsConfig.deniedTools,
    remoteDenyOutbound: channelConfig?.remoteDenyOutbound ?? false,
    // 现状仅在 browserConfig 存在且未开放远程会话时阻断；无配置等价放行
    allowRemoteSessions: args.browserConfig ? (args.browserConfig.allowRemoteSessions ?? false) : true,
    remoteScriptRequiresConfirm: channelConfig?.remoteScriptRequiresConfirm ?? true,
    navigateRequiresConfirm: args.browserConfig?.navigateRequiresConfirm ?? true,
    remoteNavigateRequiresConfirm:
      channelConfig?.remoteBrowserNavigateRequiresConfirm ??
      channelConfig?.remoteBrowserRequiresConfirm ??
      false,
    actRequiresConfirm: args.browserConfig?.actRequiresConfirm ?? true,
    remoteActSkipConfirm: shouldSkipRemoteBrowserActConfirm(channelConfig),
    larkCliWriteRequiresConfirm: args.feishuConfig?.larkCliWriteRequiresConfirm ?? true
  }

  // ===== 决策（缓存走 AuditedDecisionCache，落 cache.hit 审计）=====
  const cache: DecisionCacheView = args.appDb
    ? new AuditedDecisionCache({
        cache: new SqliteDecisionCache(getDbConnection(args.appDb)),
        audit,
        sessionId: args.sessionId,
        lane,
        origin
      })
    : EMPTY_CACHE
  const deps: PolicyEngineDeps = {
    cache,
    config,
    migrationComplete: isRemoteSecurityMigrationComplete(channelConfig),
    autoEvaluator: (f) => {
      if (f.toolName === 'run_shell') {
        return shellSkipConfirm
          ? { approve: true as const, reason: 'shell-precheck' }
          : { approve: false as const, reason: 'shell-precheck 未放行' }
      }
      if (f.toolName === 'write_file' || f.toolName === 'edit_file') {
        return fileAutoApprove === true
          ? { approve: true as const, reason: 'desktop-auto-approve' }
          : { approve: false as const, reason: '文件自动审批未通过' }
      }
      return { approve: false as const, reason: '无评估器' }
    }
  }
  // 生效规则集已在上方加载（自动审批预计算依赖），此处直接判定
  const decision = decide(facts, context, rules, deps)

  // 判定即记录（§5.6）：policy.decision 事件
  audit.record({
    ts: Date.now(),
    event: 'policy.decision',
    lane,
    origin,
    sessionId: args.sessionId,
    toolName: args.toolName,
    actionClass: facts.actionClass,
    riskLevel: facts.baseRiskLevel,
    factsSummary: facts.summary.text,
    signals: facts.signals.map((s) => s.kind),
    decision: decision.type,
    ruleId: decision.ruleId,
    reason: decision.type === 'require-confirm' ? decision.ruleId : decision.reason,
    actor: 'system'
  })

  if (decision.type === 'deny' && decision.ruleId.startsWith('remote-outbound-budget-pause-')) {
    result.budgetPause = outboundBudgetMessage ?? { message: decision.reason, reason: 'remote_task_budget' }
  }
  result.decision = decision
  result.facts = facts
  return result
}
