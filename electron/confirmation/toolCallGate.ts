import { decide } from '../../src/shared/policy/policyEngine'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { getBuiltinToolMetadata } from '../../src/shared/builtinToolMetadata'
import { mcpToolNeedsConfirmation } from '../../src/shared/mcpTypes'
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
import { listProfiles } from '../mcp/mcpConfigStore'
import type { McpToolSnapshotEntry } from '../mcp/mcpToolRegistry'
import type { RemoteContext } from '../tools/types'
import type { AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { checkRemoteTaskBudget, type RemoteTaskBudgetState } from '../remote/remoteTaskBudget'
import { remoteWriteGrantRegistry } from '../remote/remoteWriteGrantRegistry'
import { isRequestLeaseOwner } from '../remote/remoteAgentRegistry'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import {
  isRemoteSecurityMigrationComplete,
  shouldSkipRemoteBrowserActConfirm
} from '../remote/remoteToolPolicy'
import { AuditedDecisionCache } from './auditedDecisionCache'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { getSecurityAuditLog } from './audit'
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

  // ===== 桌面写/编辑自动审批（confirmMode=auto 时预计算，评估器闭包消费）=====
  let fileAutoApprove: boolean | undefined
  if (
    !args.remoteContext &&
    (args.toolName === 'write_file' || args.toolName === 'edit_file') &&
    args.toolsConfig.confirmMode === 'auto'
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
    // MCP：默认始终确认；仅 readonly-auto + 安全注解免确认（不产信号，落默认表 read → 放行）。
    const profile = args.appDb
      ? listProfiles(args.appDb).find((p) => p.id === args.mcpEntry!.serverId)
      : undefined
    const needsConfirm = profile ? mcpToolNeedsConfirmation(profile, args.mcpEntry) : true
    facts = {
      toolName: args.toolName,
      actionClass: needsConfirm ? 'write' : 'read',
      baseRiskLevel: 'medium',
      signals: needsConfirm
        ? [
            {
              kind: 'mcp-tool',
              serverId: args.mcpEntry.serverId,
              toolName: args.mcpEntry.originalName
            }
          ]
        : [],
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
  if (
    args.remoteContext &&
    (args.toolName === 'write_file' || args.toolName === 'edit_file')
  ) {
    const originSessionId = args.remoteContext.originSessionId ?? args.sessionId
    const authOwner = args.remoteContext.authOwner ?? args.remoteContext.userId ?? ''
    const gen =
      args.remoteContext.authorizationGeneration ??
      remoteAuthorizationRegistry.getGeneration(args.remoteContext.source)
    const leaseOk =
      Boolean(args.remoteContext.requestId) &&
      isRequestLeaseOwner(originSessionId, args.remoteContext.requestId!)
    const grant =
      authOwner && leaseOk
        ? remoteWriteGrantRegistry.findActive({
            channel: args.remoteContext.source,
            owner: authOwner,
            originSessionId,
            workDirProfileId: args.remoteContext.workDirProfileId ?? 'default',
            authorizationGeneration: gen
          })
        : null
    context.remoteWriteGrant = grant
      ? { remainingOps: grant.remainingOps, remainingBytes: grant.remainingBytes }
      : null
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
  const decision = decide(facts, context, DEFAULT_POLICY_RULES, deps)

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
