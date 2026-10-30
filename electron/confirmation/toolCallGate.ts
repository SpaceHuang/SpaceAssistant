import { createHash } from 'node:crypto'
import { buildScriptExecutionEnv, stableScriptMaterialDigest } from '../processOutputEncoding'
import fsPromises from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { decide, ruleMatchesInvocation } from '../../src/shared/policy/policyEngine'
import { createImAttachmentFacts } from '../../src/shared/confirmation/imAttachmentFacts'
import type { PolicyRule } from '../../src/shared/confirmation/types'
import { resolveImPolicyFloorForVersion, validatePolicyRulesFloor } from '../../src/shared/policy/policyFloor'
import { extractScriptSignals } from './extractors/scriptAnalysisExtractor'
import { analyzeScriptContent, parsePythonModule, type ScriptAnalysisResult } from '../shell/scriptContentSecurity'
import type { IrModule } from '../shell/scriptIr/types'
import { getBuiltinToolMetadata } from '../../src/shared/builtinToolMetadata'
import type {
  AutoApproveFallback,
  BrowserConfig,
  FeishuConfig,
  ShellConfig,
  ToolsConfig,
  WeChatConfig,
  WikiConfig
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
  FactSignal,
  OriginInfo,
  PolicyEngineDeps
} from '../../src/shared/confirmation/types'
import os from 'os'
import { hasUnsupportedV1ReadTarget, runExtractors, runExtractorsWithReadPathFact } from './extractors/runExtractors'
import { probeReadPathFact, ReadPathProbeError, type ReadPathFact } from './extractors/readPathFacts'
import { probeFeishuMediaTarget, type FeishuMediaTargetFact } from './extractors/feishuMediaFacts'
import { classifyWriteTargetScope, probeWritePathFact, WritePathProbeError, type WritePathFact } from './extractors/writePathFacts'
import { extractPathField } from '../toolPathField'
import { resolveSafeWorkDirPath } from '../pathSecurity'
import { buildReadExecutionPermit, readInputDigest, type ReadExecutionPermit, type ReadPermitScope } from './readExecutionPermit'
import type { WriteExecutionPermit } from './writeExecutionPermit'
import { readConfirmationRegistry, type ReadConfirmationRegistry } from './readConfirmationRegistry'
import { validateDesktopReadV1 } from '../../src/shared/policy/readPolicyV1'
import type { SessionDirectoryGrantRecord } from '../../src/shared/sessionDirectoryGrant'
import { matchSessionDirectoryGrant } from './sessionDirectoryGrantMatcher'
import { DEFAULT_USER_CONFIRMATION_TIMEOUT_MS } from './confirmationTimeout'
import { SYSTEM_INVARIANT_ID_BY_GATE_RULE } from '../../src/shared/security/systemInvariantIds'
import type { AutomationRunOutputScope, TargetBinding } from '../../src/shared/automationTaskTypes'
import { matchesAutomationRunOutputWriteTarget, matchesBoundOutputWriteTarget } from '../butler/taskOutputDirectory'
import { matchAutomationResultWritePermission } from '../butler/automationTaskPermissionMatch'
import { createWikiLifecycleController } from '../wiki/wikiLifecycle'
import { createOutsideEditReviewFields, REVIEW_MATERIAL_MAX_BYTES } from './imEditReviewMaterials'

/**
 * T1.2/T1.3：以 resolveWikiMount 为本次路径入参构造探测锚点与敏感根豁免。
 * 锚点仅在该入参挂载命中时返回（单元素数组）；豁免仅在 wiki 启用时返回（面 = 共享库子树）。
 * wiki 停用返回空对象——探测入参与现状逐字节一致。
 */
function wikiProbeContext(
  args: { workDir: string; userDataDir: string; wikiConfig?: WikiConfig },
  pathInput: string
): { mountAnchors?: MountAnchor[]; sensitiveRootExemptions?: string[] } {
  const wikiConfig = args.wikiConfig
  if (!wikiConfig) return {}
  const rootDirname = wikiConfig.rootPath || DEFAULT_WIKI_ROOT_DIRNAME
  const sensitiveRootExemptions = [path.join(args.userDataDir, rootDirname)]
  const resolution = resolveWikiMount(args.workDir, wikiConfig, args.userDataDir, pathInput)
  // P1-2：锚点前缀用挂载层带出的 matchedPrefix（多段别名时 split('/') 会退化为首段，与 realRel 不一致）
  const mountAnchors = resolution.mounted
    ? [{ base: resolution.realBase, vocabularyPrefix: resolution.matchedPrefix }]
    : undefined
  return { mountAnchors, sensitiveRootExemptions }
}

/**
 * T1.10：wiki-raw 信号判定。挂载命中（含 realBase 绝对形态的反向命中）一律以 vocabularyPath
 * 参与分类；未挂载维持既有词汇判定，deny 规则本体零改动。
 */
function isWikiRawSignalTarget(args: { workDir: string; userDataDir: string; wikiConfig?: WikiConfig }, rawPath: string): boolean {
  const wikiConfig = args.wikiConfig
  if (!wikiConfig) return false
  const resolution = resolveWikiMount(args.workDir, wikiConfig, args.userDataDir, rawPath)
  const vocabulary = resolution.mounted
    ? resolution.vocabularyPath
    : resolveWikiRelPath(args.workDir, wikiConfig, rawPath)
  return classifyWikiPath(args.workDir, wikiConfig, vocabulary) === 'raw'
}
import { precheckRunShellTool } from '../shell/shellToolLoopHelpers'
import { analyzeShellCommand } from '../shell/analyzeShellCommand'
import { classifyShellCommandEffect } from './extractors/shellEffectFacts'
import { extractScriptPathFacts, type ScriptPathFacts } from './extractors/scriptPathFacts'
import { getEffectiveSensitivePrefixes } from '../shell/shellSensitivePaths'
import { matchAutomationGrepPermission, matchAutomationMcpPermission, matchAutomationScriptPermission, resolveAutomationShellWorkingDirectory } from '../butler/automationTaskPermissionMatch'
import { evaluateFileToolAutoApproval } from '../tools/writeFileAutoApproval'
import { extractHostname } from '../browser/urlSecurity'
import type { ActDangerAssessment } from '../browser/browserActionPolicy'
import { classifyLarkCliImpact } from '../feishu/larkCliImpactPolicy'
import type { McpToolSnapshotEntry } from '../mcp/mcpToolRegistry'
import type { RemoteContext } from '../tools/types'
import { checkRemoteTaskBudget, type RemoteTaskBudgetState } from '../remote/remoteTaskBudget'
import {
  isRemoteSecurityMigrationComplete,
  shouldSkipRemoteBrowserActConfirm
} from '../remote/remoteToolPolicy'
import { AuditedDecisionCache } from './auditedDecisionCache'
import { getSecurityAuditLog } from './audit'
import { auditFactId } from './auditFactId'
import { effectiveActionFor, type PolicyPackage } from '../../src/shared/policy/policyPackages'
import { createPolicyDecision, selectPolicyDependencyRules } from '../../src/shared/policy/policyDecision'
import type { ShellAnalysisResult } from '../shell/shellTypes'
import { classifyWikiPath, resolveWikiRelPath } from '../wiki/wikiPaths'
import { resolveWikiMount } from '../wiki/wikiMount'
import type { MountAnchor } from './extractors/mountAnchors'
import { DEFAULT_WIKI_ROOT_DIRNAME } from '../../src/shared/wikiConstants'
import { buildSafetyDiagnostics, type SafetyDiagnostics } from '../../src/shared/confirmation/diagnostics'
import { extractMcpInvocationSignal } from './extractors/mcpPayloadExtractor'
import { hashMcpToolDescription, hashMcpToolSchema } from '../mcp/mcpToolRegistry'
import { approvalPayloadDeclForMcp, assertApprovalPayloadComplete } from './extractors/approvalPayloadDecl'
import type { WorkspaceSnapshot } from '../../src/shared/agent/workspace'
import { sanitizeAgentText } from '../../src/shared/agentSafeText'
import type { ShellSecurityHints } from '../../src/shared/domainTypes'
import { CONFIRMATION_LABELS } from '../../src/shared/confirmation/labels'
import { createInvocationFactsSnapshot } from '../../src/shared/confirmation/invocationFactsSnapshot'
import { ReviewScopeCache, type ReviewScopeCandidate } from './reviewScopeCache'
import { verifyReviewFileReceipt } from '../safeAtomicWrite'
import { isReviewScopeWriteEligible, projectReviewScopeEditResult } from './reviewScopeEligibility'


/** 出站写工具判定（等价现 toolChatLoop.isOutboundWriteTool：未知/非读 fail-closed 计写）。 */
export function isOutboundWriteTool(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName === 'wechat_send' || toolName === 'wechat_reply') return true
  if (toolName !== 'run_lark_cli') return false
  return classifyLarkCliImpact(toolInput.args).impact !== 'read'
}

export { validatePolicyRulesFloor }

/** 门控消费的决策缓存完整形状（lookup + 写/清理族；由装配期注入 SqliteDecisionCache 或等价内存实现）。 */
export type GateDecisionCache = import('./auditedDecisionCache').AuditedDecisionCacheDeps['cache']

export interface ToolCallGateArgs {
  toolName: string
  toolInput: Record<string, unknown>
  /** Host prepared immutable shell execution facts, projected only for v3 review. */
  preparedShellReview?: {
    command: string
    cwd: string
    timeoutSeconds: number
    shell: string
    environmentKeys: string[]
    environmentFingerprint: string
    planDigest: string
    behaviorCoverage: 'complete' | 'partial'
  }
  sessionId: string
  workDir: string
  /** Frozen task roots supplied by the trusted automation run snapshot. */
  taskWorkDirs?: readonly string[]
  /** Access grants frozen into the trusted automation run snapshot. */
  taskAccessPermissions?: import('../../src/shared/automationTaskTypes').AutomationTaskAccessPermissions
  /** Frozen output targets from this run's validated preflight snapshot. */
  taskOutputBindings?: readonly TargetBinding[]
  /** Archive directory resolved from the run's frozen scheduledFor slot. */
  taskRunOutputDir?: string
  /** Full host-derived archive scope matched against the task's immutable result-write receipt. */
  taskRunOutputScope?: AutomationRunOutputScope
  userDataDir: string
  /** R1/R2：装配期解析的工作目录快照（诊断 basis 的权威来源；缺省用 workDir 字符串兜底） */
  workspace?: WorkspaceSnapshot
  /** 显式 lane（偏差 21：由驱动源层解析后随调用传入）；缺省回退 remoteContext 推导，最终 desktop。 */
  lane?: ExecutionLane
  remoteContext?: RemoteContext
  /** Only loaded from the canonical desktop session record by the invocation assembler. */
  sessionDirectoryGrants?: readonly SessionDirectoryGrantRecord[]
  toolsConfig: ToolsConfig
  shellConfig?: ShellConfig | null
  browserConfig?: BrowserConfig | null
  feishuConfig?: FeishuConfig
  wechatConfig?: WeChatConfig
  /** Canonical shared IM policy snapshot loaded from the main-process policy store. */
  imPolicySnapshot?: import('../remote/remoteToolPolicy').RemoteSecurityPolicyConfig['policySnapshot']
  /** Versioned authorization identity for the lane's persisted policy domain. */
  policyBinding?: { domain: 'desktop' | 'im' | 'automation'; policyBehaviorVersion: string; revision: number; epoch: number }
  /** Display-only task digest and its loss marker; cache identity uses the exact host evidence below. */
  taskDigest?: string
  taskDigestTruncated?: boolean
  /** Exact task plus complete serialized authoritative context; oversized or missing evidence cannot cache. */
  reviewScopeTaskIdentity?: string
  /** Positive host attestation that task and selected reference evidence reached the reviewer without clipping. */
  reviewScopeEvidenceComplete?: boolean
  reviewScopeCache?: ReviewScopeCache
  /** Host-resolved provenance for the MCP query/data scope; never read from model arguments. */
  mcpQuerySource?: 'public' | 'local-sensitive' | 'unknown'
  /** Host-resolved permission for the configured MCP account and referenced data scope. */
  mcpAccountAuthorization?: 'authorized' | 'unauthorized' | 'unknown'
  wikiConfig?: WikiConfig
  /** Action class from the host's registered tool contract for dynamically discovered tools. */
  registeredActionClass?: import('../../src/shared/confirmation/types').ActionClass
  /** 装配期解析的生效规则集（B1：必填，缺料 fail-loud，不回退内置默认规则）。 */
  effectiveRules: PolicyRule[]
  /** Trusted disabled locked-deny IDs loaded from persisted security settings. */
  disabledPolicyRuleIds?: readonly string[]
  /**
   * 「自动」变换的档位来源（§2.1 LANE_PROFILES，与 effectiveRules 同源装配注入）；
   * 缺省 standard——装配方未显式声明时按恒等处理（fail-safe：少自动化不多自动化）。
   */
  lanePackage?: PolicyPackage
  /** 装配期随规则集携带的来源标注（P3）；审计据此回答规则为何未生效。 */
  policyOrigins?: Record<string, { source: 'builtin' | 'package' | 'user-override' | 'migration' }>
  /**
   * P5（偏差 4）factsProvider 端口：宿主补充审批可见输入（返回 undefined = 本次无补充；
   * 未提供端口 = 忘了声明——两者在 facts.factsProviderDeclared 上可区分）。
   */
  factsProvider?: (input: { toolName: string; toolInput: Record<string, unknown> }) =>
    import('../../src/shared/confirmation/types').FactSignal[] | undefined
  /** 装配期构造的决策缓存视图（B1：必填，缺料 fail-loud，不回退空缓存）。 */
  decisionCache: GateDecisionCache
  /** 装配期注入的 shell 预检材料（B1：必填；trusted-command 记账写不允许静默停写）。 */
  shellPrecheck: { touchTrustedCommand: (command: string) => void }
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
  /**
   * P2-4 递归守卫（I5，硬约束）：审批执行链调用时传入的内部标记（代码写死，不进配置与规则集）。
   * gate 看到 require-confirm 决策 + 该标记 → 改写为 deny(cause=recursion-blocked)。
   * 守卫只认标记不认业务身份；豁免失效兜底由 AgentChannel 深度计数承担。
   */
  internalConfirmExemption?: 'approval-agent'
  requestId?: string
  toolUseId?: string
  readConfirmationRegistry?: ReadConfirmationRegistry
  /** Recheck-only mode forbids confirmation registration and trusted-command writes. */
  phase?: 'initial' | 'recheck'
  /** SDK host tells the evaluator a matching request was approved; SafetyPolicy still verifies rule/facts identity. */
  previouslyConfirmed?: boolean
  /** Allow the Hosted safety adapter to re-run the side-effect-free desktop file fast-track on recheck. */
  evaluateFastTrackOnRecheck?: boolean
}

/** Build one invocation-scoped gate request; identity, canonical input and phase cannot drift apart. */
export function buildToolCallGateArgs(
  context: Omit<ToolCallGateArgs, 'toolName' | 'toolInput' | 'requestId' | 'toolUseId' | 'phase' | 'previouslyConfirmed' | 'evaluateFastTrackOnRecheck'> & Partial<Pick<ToolCallGateArgs, 'requestId' | 'toolUseId'>>,
  call: Readonly<{ toolName: string; toolInput: Record<string, unknown>; requestId: string; toolUseId: string; phase?: ToolCallGateArgs['phase']; previouslyConfirmed?: boolean; evaluateFastTrackOnRecheck?: boolean }>
): ToolCallGateArgs {
  if (!call.toolName.trim() || !call.requestId.trim() || !call.toolUseId.trim()) throw new Error('TOOL_GATE_CALL_IDENTITY_REQUIRED')
  return {
    ...context,
    toolName: call.toolName,
    toolInput: structuredClone(call.toolInput),
    requestId: call.requestId,
    toolUseId: call.toolUseId,
    ...(call.phase ? { phase: call.phase } : {}),
    ...(call.previouslyConfirmed ? { previouslyConfirmed: true } : {}),
    ...(call.evaluateFastTrackOnRecheck ? { evaluateFastTrackOnRecheck: true } : {})
  }
}

export interface ToolCallGateResult {
  /** Host-derived execution lane, carried into write permits for lane-specific final checks. */
  lane?: ExecutionLane
  decision: Decision
  policyDecision?: import('../../src/shared/policy/policyDecision').PolicyDecision
  facts: ContentFacts
  factsSnapshot?: import('../../src/shared/confirmation/invocationFactsSnapshot').InvocationFactsSnapshot
  approvedFactIds: Array<{ factId: string; decisionRuleId: string }>
  readTargetMapping?: Array<{ factId: string; decisionRuleId: string }>
  readExecutionPermit?: ReadExecutionPermit
  readPathFact?: import('./extractors/readPathFacts').ReadPathFact
  wechatMediaPathFact?: ReadPathFact
  feishuMediaFact?: FeishuMediaTargetFact
  writePathFact?: WritePathFact
  reviewScopeCandidate?: import('../../src/shared/confirmation/types').ReviewScopeApprovalCandidate
  /** Host-only materials for write receipt handoff; never copied into approval clues or logs. */
  reviewScopeCandidateScope?: ReviewScopeCandidate
  reviewScopeCandidateDigest?: string
  /** Host-issued output binding attestation; consumed by the execution permit final-check. */
  automationOutputBinding?: { binding: Extract<TargetBinding, { kind: 'output' }>; runOutputDir: string }
  /** Host-issued result-directory grant attestation; consumed by the execution permit final-check. */
  automationOutputScope?: AutomationRunOutputScope
  writeExecutionPermit?: WriteExecutionPermit
  /** Host prepared execution plan projection for bounded Git-query approvals. */
  preparedShellReview?: { command: string; cwd: string; timeoutSeconds: number; shell: string; environmentKeys: string[]; environmentFingerprint: string; planDigest: string; behaviorCoverage: 'complete' | 'partial' }
  /** run_shell 预检通过时的结构化结果（供日志/确认卡片 hints）。 */
  shellPrecheck?: { analysis: ShellAnalysisResult; legacyAutoAllowEligible: boolean; legacyPolicy: import('../shell/legacyShellPolicyAdapter').LegacyShellPolicyInput; hints: ShellSecurityHints }
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
  /** H2：写文件自动批准（快通道批准 && 决策放行）——审计与持久 meta 的判定来源 */
  fileAutoApproved?: boolean
  /** MCP 条目回传（确认卡片载荷）。 */
  mcpEntry?: McpToolSnapshotEntry
  /** run_script 原始分析（拒绝消息桥接 / 日志 patterns）。 */
  rawScriptAnalysis?: ScriptAnalysisResult
  /** run_script 路径分析未覆盖时的用户提示。 */
  scriptPathHint?: string
  /** R2：结构化诊断（deny / require-confirm 与 decision 成对出现；auto-allow 不产）。 */
  diagnostics?: SafetyDiagnostics
}

function buildScriptPathHint(unknownReason: 'dynamic-execution' | 'unmodeled-call' | null | undefined, evidence: ReadonlyArray<{ call: string; reason: 'dynamic-execution' | 'unmodeled-call' }>, declaration?: 'workdir-readonly'): string {
  const names = evidence.map((item) => item.call)
  const prefix = unknownReason === 'dynamic-execution' ? CONFIRMATION_LABELS.scriptDynamicExecutionHintPrefix : CONFIRMATION_LABELS.scriptPathUnknownHintPrefix
  const body = names.length ? names.join('、') : CONFIRMATION_LABELS.scriptPathUnknownHintFallback
  return `${prefix}${body}${declaration ? `；${CONFIRMATION_LABELS.scriptDeclarationHint}` : ''}`
}

function laneOf(remoteContext: RemoteContext | undefined, explicitLane?: ExecutionLane): ExecutionLane {
  if (explicitLane) return explicitLane
  if (!remoteContext) return 'desktop'
  return remoteContext.source === 'feishu' ? 'feishu' : 'wechat'
}

/**
 * §5.5 直线流程的门控段：组装 ExecutionContext → 事实提取 → decide() → 落 policy.decision 审计。
 * 通道确认、记账（recordOutboundWrite / grant reserve）与拒绝消息映射仍由主循环承担。
 */
export async function evaluateToolCallGate(args: ToolCallGateArgs): Promise<ToolCallGateResult> {
  const lane = laneOf(args.remoteContext, args.lane)
  const origin: OriginInfo = { kind: 'direct-owner' }
  const audit = args.audit ?? getSecurityAuditLog()
  const result: ToolCallGateResult = {
    lane,
    decision: undefined as unknown as Decision,
    facts: undefined as unknown as ContentFacts,
    approvedFactIds: []
  }

  // ===== B1 缺料 fail-loud：端口材料缺失 = 调用失败 + 审计（不回退任何静默默认）=====
  const materialsMissing: string[] = []
  if (!Array.isArray(args.effectiveRules)) materialsMissing.push('effectiveRules')
  if (!args.decisionCache || typeof args.decisionCache.lookup !== 'function') materialsMissing.push('decisionCache')
  if (!args.shellPrecheck || typeof args.shellPrecheck.touchTrustedCommand !== 'function') materialsMissing.push('shellPrecheck')
  if (materialsMissing.length > 0) {
    audit.record({
      ts: Date.now(),
      event: 'policy.decision',
      lane,
      origin,
      sessionId: args.sessionId,
      requestId: args.requestId,
      toolUseId: args.toolUseId,
      toolName: args.toolName,
      riskLevel: 'high',
      factsSummary: args.toolName,
      signals: [],
      decision: 'deny',
      ruleId: 'gate-materials-missing',
      reason: `TOOL_GATE_MATERIALS_MISSING(${materialsMissing.join(',')})`,
      cause: 'gate-materials-missing',
      actor: 'system'
    })
    throw new Error(`TOOL_GATE_MATERIALS_MISSING(${materialsMissing.join(',')})`)
  }
  if (lane === 'wechat' || lane === 'feishu') {
    const snapshot = args.imPolicySnapshot
    const supported = snapshot?.domain === 'im' &&
      ['im-v1.6', 'im-standard-v2', 'im-standard-v3'].includes(snapshot.policyBehaviorVersion) &&
      Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 &&
      !!snapshot.snapshot && typeof snapshot.snapshot === 'object' && !Array.isArray(snapshot.snapshot)
    if (!supported) {
      audit.record({
        ts: Date.now(), event: 'policy.decision', lane, origin, sessionId: args.sessionId,
        requestId: args.requestId, toolUseId: args.toolUseId, toolName: args.toolName,
        riskLevel: 'high', factsSummary: args.toolName, signals: [], decision: 'deny',
        ruleId: 'im-policy-snapshot-missing', reason: 'IM_POLICY_SNAPSHOT_REQUIRED', cause: 'gate-materials-missing', actor: 'system'
      })
      throw new Error('IM_POLICY_SNAPSHOT_REQUIRED')
    }
  }

  // ===== P3 底线校验（§7.1 判据 2）：传入规则集相对 locked 底线可收紧不可放宽 =====
  // 违规 → 拒绝本次工具调用 + cause=rules-violated 审计（与正常拒绝、缺料失败互斥不混计）
  const floor = lane === 'wechat' || lane === 'feishu'
    ? resolveImPolicyFloorForVersion(args.imPolicySnapshot?.policyBehaviorVersion, args.lanePackage ?? 'standard')
    : undefined
  const floorCheck = validatePolicyRulesFloor(args.effectiveRules, floor)
  if (!floorCheck.ok) {
    result.decision = {
      type: 'deny',
      ruleId: 'rules-violated',
      reason: `POLICY_RULES_FLOOR_VIOLATED(${floorCheck.violations.join(',')})`,
      disposition: 'forbidden', cause: 'rules-violated'
    }
    result.facts = {
      toolName: args.toolName,
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals: [],
      summary: { text: args.toolName }
    }
    audit.record({
      ts: Date.now(),
      event: 'policy.decision',
      lane,
      origin,
      sessionId: args.sessionId,
      requestId: args.requestId,
      toolUseId: args.toolUseId,
      toolName: args.toolName,
      riskLevel: 'high',
      factsSummary: args.toolName,
      signals: [],
      decision: 'deny',
      ruleId: 'rules-violated',
      reason: `POLICY_RULES_FLOOR_VIOLATED(${floorCheck.violations.join(',')})`,
      cause: 'rules-violated',
      actor: 'system'
    })
    return result
  }

  // ===== 前置 validator：run_shell 预检（deny 短路，不进引擎）=====
  let shellLegacyAutoAllowEligible = false
  let shellAnalysis: ShellAnalysisResult | undefined
  let shellPathSignals: import('../../src/shared/confirmation/types').FactSignal[] = []
  let shellPathProbeFailed = false
  if (args.toolName === 'run_shell') {
    const command = typeof args.toolInput.command === 'string' ? args.toolInput.command : ''
    shellAnalysis = await analyzeShellCommand(args.workDir, command, process.platform, args.shellConfig, args.userDataDir)
    const shellFacts = shellAnalysis.facts
    if (!shellFacts || shellFacts.analysisCompleteness !== 'complete') shellPathProbeFailed = true
    const pathLiterals = [...(shellFacts?.paths ?? []), ...(shellFacts?.redirects ?? []), ...shellAnalysis.pathVerdict.violations.map((v) => v.path ?? ''), ...(shellAnalysis.shellSecurityHints.scannedPaths ?? [])]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    const home = os.homedir()
    const uniquePaths = new Set<string>()
    for (const literal of pathLiterals) {
      const expanded = literal.replace(/^~(?=$|[\\/])/, home).replace(/\$\{?HOME\}?/g, home).replace(/%USERPROFILE%/ig, home)
      try {
        const wikiProbe = wikiProbeContext(args, expanded)
        const fact = await probeWritePathFact({ rawPath: expanded, workDir: args.workDir, workDirs: args.taskWorkDirs, userDataDir: args.userDataDir, homeDir: home,
          customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? [], mountAnchors: wikiProbe.mountAnchors,
          sensitiveRootExemptions: wikiProbe.sensitiveRootExemptions })
        if (uniquePaths.has(fact.normalizedPath)) continue
        uniquePaths.add(fact.normalizedPath)
        shellPathSignals.push({ kind: 'path-target', path: fact.vocabularyPath ?? fact.normalizedPath, zone: fact.zone })
      } catch {
        shellPathProbeFailed = true
      }
    }
    if (shellAnalysis.shellSecurityHints.outsideWorkDirRisk) shellPathSignals.push({ kind: 'path-outside-heuristic', reason: 'command-may-touch-outside-workdir' })
    shellPathSignals.push({ kind: 'command-effect', effect: classifyShellCommandEffect(command, shellAnalysis) })
    const onlyGitQuery = shellFacts?.analysisCompleteness === 'complete' && shellFacts.operations.length === 1 &&
      shellFacts.unresolved.length === 0 && (shellFacts.connectors?.length ?? 0) === 0 && (shellFacts.redirects?.length ?? 0) === 0 &&
      shellFacts.operations[0]?.verb.toLowerCase().split(/[\\/]/).pop() === 'git'
    if (onlyGitQuery) {
      const gitArgs = shellFacts!.operations[0]!.args
      const subcommandIndex = gitArgs.findIndex((arg) => !arg.startsWith('-'))
      const subcommand = gitArgs[subcommandIndex]?.toLowerCase()
      const options = gitArgs.filter((_, index) => index !== subcommandIndex)
      if ((subcommand === 'status' || subcommand === 'log') && options.every((arg) => ['--short', '--oneline', '--decorate', '--no-color'].includes(arg))) {
        shellPathSignals.push({ kind: 'im-shell-review-candidate', command: subcommand === 'status' ? 'git-status' : 'git-log' })
      }
    }
    if (shellPathProbeFailed) shellPathSignals.push({ kind: 'extraction-failed', reason: 'shell-path-facts-incomplete' })
    const precheck = await (args.runShellPrecheck ?? precheckRunShellTool)({
      command,
      workDir: args.workDir,
      userDataDir: args.userDataDir,
      shellConfig: args.shellConfig,
      // Automation uses per-task approval, never desktop trusted-command state or its cache side effects.
      shellPrecheck: lane === 'automation' || args.phase === 'recheck' ? undefined : args.shellPrecheck,
      analysis: shellAnalysis
    })
    if (!precheck.ok) {
      result.shellPrecheckDeny = {
        error: precheck.error,
        auditReason: precheck.auditReason,
        ...(precheck.validatorId ? { validatorId: precheck.validatorId } : {}),
        ...(precheck.denyType ? { denyType: precheck.denyType } : {})
      }
      result.decision = { type: 'deny', ruleId: 'shell-precheck-deny', reason: precheck.error, disposition: 'forbidden', cause: 'shell-precheck-deny' }
      result.facts = {
        toolName: args.toolName,
        actionClass: 'execute',
        baseRiskLevel: 'high',
        signals: shellPathSignals,
        summary: { text: args.toolName }
      }
      // 判定即记录（§5.6）：预检硬拒同样落 policy.decision，最高频拒绝不得在审计中缺失
      audit.record({
        ts: Date.now(),
        event: 'policy.decision',
        lane,
        origin,
        sessionId: args.sessionId,
        requestId: args.requestId,
        toolUseId: args.toolUseId,
        toolName: args.toolName,
        actionClass: 'execute',
        riskLevel: 'high',
        factsSummary: args.toolName,
        signals: shellPathSignals.map((signal) => signal.kind),
        decision: 'deny',
        ruleId: 'shell-precheck-deny',
        reason: `shell-precheck-deny:${precheck.denyType ?? 'unknown'}`,
        actor: 'system'
      })
      return result
    }
    result.shellPrecheck = {
      analysis: precheck.analysis,
      legacyAutoAllowEligible: precheck.legacyAutoAllowEligible,
      legacyPolicy: precheck.legacyPolicy,
      hints: precheck.hints
    }
    shellLegacyAutoAllowEligible = precheck.legacyAutoAllowEligible && !shellPathProbeFailed && !shellPathSignals.some((s) => s.kind === 'path-target' && (s.zone === 'sensitive-file' || s.zone === 'system-dir'))
    if (lane === 'automation') shellLegacyAutoAllowEligible = false
  }

  // ===== 生效规则集（§4 第 1 区 + §2.1「自动」语义）：装配期解析注入（B1，门控不持库）=====
  // IM 的套餐动作与持久化用户覆盖已由 resolveEffectivePolicyRulesWithOrigin 合并；这里直接消费最终规则，
  // 避免按套餐再次映射覆盖动作。lanePackage 仍用于引擎合成规则及桌面「自动」动作变换。
  const lanePackage = args.lanePackage ?? 'standard'
  const rules = args.effectiveRules

  // ===== 环境事实 =====
  const env: EnvFacts = {
    os: process.platform,
    workDir: args.workDir,
    sensitivePaths: getEffectiveSensitivePrefixes(
      args.userDataDir,
      args.shellConfig?.customSensitivePrefixes ?? [],
      process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'posix',
      os.homedir()
    )
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

  const shellZones = shellPathSignals.flatMap((signal) => signal.kind === 'path-target' ? [signal.zone] : [])
  const shellOutsideReadOnly = lane === 'desktop' && args.toolName === 'run_shell' && shellZones.length > 0 && shellZones.every((zone) => zone === 'outside-workdir') && shellPathSignals.some((signal) => signal.kind === 'command-effect' && signal.effect === 'read-only') && !shellPathProbeFailed && !shellPathSignals.some((signal) => signal.kind === 'path-outside-heuristic' || signal.kind === 'extraction-failed')

  // ===== 事实提取 =====
  let facts: ContentFacts
  let readPathFact: import('./extractors/readPathFacts').ReadPathFact | undefined
  let wechatMediaPathFact: ReadPathFact | undefined
  let reviewedAttachmentContent: { path: string; fileName: string; content: string; contentDigest: string; inspectionCoverage: 'complete' | 'partial'; evidenceKinds: readonly string[] } | undefined
  let feishuMediaFact: FeishuMediaTargetFact | undefined
  let readPathProbeFailure: ReadPathProbeError | undefined
  let writePathFact: WritePathFact | undefined
  let automationOutputBinding: ToolCallGateResult['automationOutputBinding']
  let automationOutputScope: ToolCallGateResult['automationOutputScope']
  let writePathProbeFailure: WritePathProbeError | undefined
  let wikiRawTargetFailure = false
  let writePathInputFailure = false
  if (args.mcpEntry) {
    // MCP：总是产 mcp-tool；只读自动通道还要求当前 descriptor 有效、必填参数完整、没有写目的，
    // 且宿主已证明数据源为 public、账号权限有效。server 注解单独不能建立只读事实。
    const schemaHashValid = typeof args.mcpEntry.schemaHash === 'string' &&
      args.mcpEntry.schemaHash === hashMcpToolSchema(args.mcpEntry.inputSchema)
    const descriptorHashValid = schemaHashValid && typeof args.mcpEntry.descriptorHash === 'string' &&
      args.mcpEntry.descriptorHash === hashMcpToolDescription({
        serverId: args.mcpEntry.serverId,
        originalName: args.mcpEntry.originalName,
        description: args.mcpEntry.description,
        inputSchema: args.mcpEntry.inputSchema,
        ...(args.mcpEntry.annotations ? { annotations: args.mcpEntry.annotations } : {})
      })
    const readOnlyHintValid = descriptorHashValid &&
      args.mcpEntry.annotations?.readOnlyHint === true && args.mcpEntry.annotations.destructiveHint !== true
    const initialMcpInvocation = extractMcpInvocationSignal({
      serverId: args.mcpEntry.serverId,
      toolName: args.mcpEntry.originalName,
      toolInput: args.toolInput,
      annotationsSafe: readOnlyHintValid,
      actionClass: 'write',
      querySource: args.mcpQuerySource ?? 'unknown',
      accountAuthorization: args.mcpAccountAuthorization ?? 'unknown',
      descriptorValid: descriptorHashValid,
      inputSchema: args.mcpEntry.inputSchema
    })
    const safeForAutoRead = readOnlyHintValid &&
      args.mcpQuerySource === 'public' && args.mcpAccountAuthorization === 'authorized' &&
      initialMcpInvocation.kind === 'mcp-invocation' &&
      initialMcpInvocation.sideEffect === 'read' && initialMcpInvocation.completeness === 'complete'
    const annotationsSafe = safeForAutoRead
    const mcpActionClass = safeForAutoRead ? ('read' as const) : ('write' as const)
    const mcpInvocation = initialMcpInvocation.kind === 'mcp-invocation'
      ? { ...initialMcpInvocation, actionClass: mcpActionClass }
      : initialMcpInvocation
    // R3：载荷完整性（声明来自 server inputSchema.required；未声明不误报）
    const payloadDecl = approvalPayloadDeclForMcp(args.mcpEntry.inputSchema)
    const payloadCheck = assertApprovalPayloadComplete(payloadDecl, args.toolInput)
    facts = {
      toolName: args.toolName,
      actionClass: mcpActionClass,
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
          : []),
        mcpInvocation,
        ...(payloadCheck.ok
          ? []
          : [{ kind: 'payload-incomplete' as const, toolName: args.toolName, missing: payloadCheck.missing }])
      ],
      // 分类依据写进摘要（schema-heuristic 时明示「依据：schema 无写声明」，供规则层与审计追溯）
      summary: {
        text: `MCP ${args.mcpEntry.serverName}/${args.mcpEntry.originalName}${
          mcpInvocation.kind === 'mcp-invocation' && mcpInvocation.classificationBasis === 'schema-heuristic'
            ? '（分类依据：schema 无写声明）'
            : ''
        }`
      }
    }
    if (lane === 'automation') facts.signals.push({ kind: 'automation-mcp-permission', status: descriptorHashValid && matchAutomationMcpPermission(args.taskAccessPermissions, args.mcpEntry) ? 'matched' : 'missing' })
    result.mcpEntry = args.mcpEntry
    if (!payloadCheck.ok) {
      audit.record({
        ts: Date.now(),
        lane,
        actor: 'system',
        event: 'confirm.payload-incomplete',
        sessionId: args.sessionId,
        toolName: args.toolName,
        factsSummary: `payload-incomplete: ${payloadCheck.missing.join(',')}`,
        reason: 'approval payload missing declared required fields (construction, not invocation args)'
      })
    }
  } else if (args.toolName === 'run_script') {
    const code = typeof args.toolInput.code === 'string' ? args.toolInput.code : ''
    const requestedLanguage = typeof args.toolInput.language === 'string' ? args.toolInput.language : 'python'
    const pythonLanguage = requestedLanguage === 'python'
    let preParsedIr: IrModule | undefined
    if (pythonLanguage) {
      try {
        preParsedIr = parsePythonModule(code)
      } catch {
        // 解析失败（语法错误 / 服务未就绪 / IrCoverageError）：下游 fail-closed。
      }
    }
    const language: 'python' | 'javascript' | 'typescript' | 'powershell' | 'unknown' = requestedLanguage === 'python' || requestedLanguage === 'javascript' || requestedLanguage === 'typescript' || requestedLanguage === 'powershell'
      ? requestedLanguage
      : 'unknown'
    const scriptPaths: ScriptPathFacts = pythonLanguage
      ? preParsedIr ? extractScriptPathFacts(code, 'python', preParsedIr) : {
        paths: [], completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution', unknownEvidence: []
      }
      : extractScriptPathFacts(code, language)
    const pythonSignals = pythonLanguage ? extractScriptSignals(code, env, preParsedIr) : undefined
    const signals: FactSignal[] = pythonLanguage
      ? pythonSignals!.signals
      : [{ kind: 'script-language-analysis' as const, language: language === 'python' ? 'unknown' as const : language, status: 'unverified' as const }]
    const networkReviewCandidate = signals.some((signal) => signal.kind === 'im-script-network-review-candidate' && signal.status === 'complete')
    let scriptEnvironmentDigest: string | undefined
    if (networkReviewCandidate) {
      scriptEnvironmentDigest = stableScriptMaterialDigest(buildScriptExecutionEnv(process.env, lane, true))
      signals.push({ kind: 'script-execution-environment', status: 'complete', digest: scriptEnvironmentDigest })
      const scriptSettings = {
        workDir: args.workDir, userDataDir: args.userDataDir, scriptTimeout: args.toolsConfig.scriptTimeout,
        ...(args.toolsConfig.pythonPath !== undefined ? { pythonPath: args.toolsConfig.pythonPath } : {}),
        ...(args.toolsConfig.scriptInterpreterPaths ? { scriptInterpreterPaths: args.toolsConfig.scriptInterpreterPaths } : {})
      }
      signals.push({ kind: 'script-execution-settings', status: 'complete', digest: stableScriptMaterialDigest(scriptSettings), interpreter: args.toolsConfig.pythonPath?.trim() || 'python' })
    }
    let summary = pythonLanguage
      ? pythonSignals!.summary
      : { text: `run_script ${language} 路径事实已提取；内容安全分析未认证` }
    signals.push({
      kind: 'script-path-extraction',
      completeness: scriptPaths.completeness,
      dynamicAccess: scriptPaths.dynamicAccess,
      ...(scriptPaths.completeness === 'unknown'
        ? { unknownReason: scriptPaths.unknownReason ?? 'dynamic-execution' }
        : {}),
      contentDigest: createHash('sha256').update(code, 'utf8').digest('hex'),
      workdirDigest: createHash('sha256').update(path.resolve(args.workDir), 'utf8').digest('hex'),
      parametersDigest: createHash('sha256').update(JSON.stringify({ ...args.toolInput, code }), 'utf8').digest('hex'),
      environmentDigest: stableScriptMaterialDigest({ workDir: path.resolve(args.workDir), userDataDir: path.resolve(args.userDataDir), lane, scriptEnvironmentDigest }),
      authenticationVersion: 'script-certifier-v1'
    })
    let scriptPathHint: string | undefined
    if (scriptPaths.completeness === 'unknown') {
      scriptPathHint = buildScriptPathHint(scriptPaths.unknownReason, scriptPaths.unknownEvidence ?? [], scriptPaths.declaration)
      summary = { ...summary, text: `${summary.text} ${scriptPathHint}` }
    }
    for (const rawPath of scriptPaths.paths) {
      try {
        const pathFact = await probeWritePathFact({ rawPath, workDir: args.workDir, workDirs: args.taskWorkDirs, userDataDir: args.userDataDir, homeDir: os.homedir(), customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? [] })
        signals.push({ kind: 'path-target', path: pathFact.normalizedPath, zone: pathFact.zone })
      } catch {
        signals.push({ kind: 'extraction-failed', reason: 'script-path-probe-failed' })
        signals.push({ kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: true })
      }
    }
    if (pythonLanguage && scriptPaths.declaration) {
      const consistent = scriptPaths.dynamicAccess === false
        && !signals.some((signal) => signal.kind === 'script-network')
        && !signals.some((signal) => signal.kind === 'script-analysis' && signal.signal !== 'clean')
        && !signals.some((signal) => signal.kind === 'path-target' && signal.zone !== 'workdir-normal')
        && !signals.some((signal) => signal.kind === 'extraction-failed')
      signals.push({ kind: 'script-path-declaration', scope: scriptPaths.declaration, consistent })
    }
    facts = {
      toolName: 'run_script',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals,
      summary
    }
    result.scriptPathHint = scriptPathHint
    result.rawScriptAnalysis = pythonLanguage
      ? analyzeScriptContent(code, { remote: lane !== 'desktop' }, preParsedIr)
      : { verdict: 'ask', patterns: ['script-language-analysis-unverified'], reason: '该脚本语言尚未接入完整内容安全分析' }
  } else if (args.toolName === 'write_file' || args.toolName === 'edit_file') {
    const descriptor = getBuiltinToolMetadata(args.toolName)
    const rawPath = extractPathField(args.toolInput)
    if (descriptor && (rawPath === undefined || !rawPath.trim())) {
      writePathInputFailure = true
      facts = {
        toolName: descriptor.toolName,
        actionClass: descriptor.actionClass,
        baseRiskLevel: descriptor.riskLevel,
        signals: [{ kind: 'extraction-failed', reason: 'write-path-input-invalid' }],
        summary: { text: '缺少有效的写入路径' }
      }
    } else if (descriptor && rawPath !== undefined) {
      try {
        const wikiProbe = wikiProbeContext(args, rawPath)
        writePathFact = await probeWritePathFact({
          rawPath,
          workDir: args.workDir,
          workDirs: args.taskWorkDirs,
          userDataDir: args.userDataDir,
          homeDir: os.homedir(),
          customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? [],
          mountAnchors: wikiProbe.mountAnchors,
          sensitiveRootExemptions: wikiProbe.sensitiveRootExemptions
        })
        let writeScope: 'inside-workdir' | 'outside-workdir' | 'unknown'
        try {
          // T1.4：挂载命中时以 scopeBase（realBase）为包含判定根；未挂载行为不变
          writeScope = await classifyWriteTargetScope(writePathFact.normalizedPath, writePathFact.scopeBase ?? args.workDir, writePathFact.scopeBase ? [writePathFact.scopeBase] : args.taskWorkDirs)
        } catch {
          writeScope = 'unknown'
        }
        // Facts phase: the user-confirmed result-write receipt authorizes ordinary files under this run's archive.
        if (lane === 'automation' && (args.taskRunOutputScope || args.taskRunOutputDir)
          && writePathFact.zone !== 'sensitive-file' && writePathFact.zone !== 'system-dir'
          && (writePathFact.targetKind === 'file' || writePathFact.targetKind === 'missing')
          && (args.toolName !== 'edit_file' || writePathFact.targetKind === 'file')) {
          if (args.taskRunOutputScope
            && matchAutomationResultWritePermission(args.taskAccessPermissions, args.taskRunOutputScope)
            && matchesAutomationRunOutputWriteTarget(args.taskRunOutputScope, writePathFact)) {
            automationOutputScope = args.taskRunOutputScope
          } else {
            // Compatibility: older task snapshots with an exact user-confirmed preflight binding remain valid.
            for (const binding of args.taskOutputBindings ?? []) {
              if (binding.kind !== 'output' || binding.resolverVersion !== 3) continue
              try {
                if (args.taskRunOutputDir && matchesBoundOutputWriteTarget(binding, args.taskRunOutputDir, writePathFact.normalizedPath)) {
                  automationOutputBinding = { binding, runOutputDir: args.taskRunOutputDir }
                  break
                }
              } catch {
                // Invalid/out-of-archive bindings are facts that fail to match; policy remains deny.
              }
            }
          }
        }
        facts = {
          toolName: descriptor.toolName,
          actionClass: descriptor.actionClass,
          baseRiskLevel: descriptor.riskLevel,
          signals: [
            // T1.6②：审批卡片/审计展示词汇路径（挂载命中时），真实 userData 路径不进渲染层
            { kind: 'path-target', path: writePathFact.vocabularyPath ?? writePathFact.normalizedPath, zone: writePathFact.zone },
            { kind: 'write-target-scope', scope: writeScope }
          ],
          summary: { text: `${args.toolName} 写入目标已检查` }
        }
        if (automationOutputBinding || automationOutputScope) facts.signals.push({ kind: 'automation-output-binding', status: 'matched' })
        if ((args.imPolicySnapshot?.policyBehaviorVersion === 'im-standard-v2' || args.imPolicySnapshot?.policyBehaviorVersion === 'im-standard-v3')
          && args.toolName === 'write_file' && writePathFact.targetKind === 'missing') facts.signals.push({ kind: 'write-target-new' })
        if ((args.imPolicySnapshot?.policyBehaviorVersion === 'im-standard-v2' || args.imPolicySnapshot?.policyBehaviorVersion === 'im-standard-v3')
          && args.toolName === 'edit_file' && writePathFact.targetKind === 'file') facts.signals.push({ kind: 'write-target-existing' })
        if (writePathFact.targetKind !== 'file' && writePathFact.targetKind !== 'missing') facts.signals.push({ kind: 'write-target-unsupported' })
        if (isWikiRawSignalTarget(args, rawPath)) {
          facts.signals.push({ kind: 'wiki-raw-target' })
        }
      } catch (error) {
        if (!(error instanceof WritePathProbeError)) throw error
        writePathProbeFailure = error
        wikiRawTargetFailure = isWikiRawSignalTarget(args, rawPath)
        facts = {
          toolName: descriptor.toolName,
          actionClass: descriptor.actionClass,
          baseRiskLevel: descriptor.riskLevel,
          signals: [
            { kind: 'extraction-failed', reason: error.caseId },
            ...(wikiRawTargetFailure ? [{ kind: 'wiki-raw-target' as const }] : [])
          ],
          summary: { text: '写入目标无法检查' }
        }
      }
    } else {
      facts = descriptor ? runExtractors(descriptor, args.toolInput, env, {
        ...(lane === 'feishu' && args.remoteContext?.authOwner ? { trustedFeishuActorOpenId: args.remoteContext.authOwner } : {})
      }) : {
        toolName: args.toolName, actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: args.toolName }
      }
    }
  } else {
    const descriptor = getBuiltinToolMetadata(args.toolName)
    if (descriptor) {
      if (args.toolName === 'list_directory' || args.toolName === 'grep' || (args.toolName === 'read_file' && extractPathField(args.toolInput) !== undefined)) {
        try {
          const readRawPath = extractPathField(args.toolInput)
            ?? (args.toolName === 'list_directory' || args.toolName === 'grep' ? '.' : '')
          const readWikiProbe = wikiProbeContext(args, readRawPath)
          const readResult = await runExtractorsWithReadPathFact(descriptor, args.toolInput, {
            ...env,
            userDataDir: args.userDataDir,
            homeDir: os.homedir(),
            customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? [],
            workDirs: args.taskWorkDirs,
            mountAnchors: readWikiProbe.mountAnchors,
            sensitiveRootExemptions: readWikiProbe.sensitiveRootExemptions
          })
          facts = readResult.facts
          readPathFact = readResult.readPathFact
          const readScope = args.toolName === 'list_directory'
            ? 'direct-entries' as const
            : args.toolName === 'grep' && (readPathFact.targetKind === 'directory' || readPathFact.resolvedKind === 'directory')
              ? 'subtree' as const
              : 'single-target' as const
          facts.signals.push({ kind: 'read-target-scope', scope: readScope })
          facts.signals.push({ kind: 'read-target-kind', targetKind: readPathFact.targetKind })
        } catch (error) {
          if (!(error instanceof ReadPathProbeError)) throw error
          readPathProbeFailure = error
          facts = {
            toolName: descriptor.toolName,
            actionClass: descriptor.actionClass,
            baseRiskLevel: descriptor.riskLevel,
            signals: [{ kind: 'extraction-failed', reason: readPathProbeFailure.caseId }],
            summary: { text: '读取目标无法检查' }
          }
        }
      } else if (args.toolName === 'read_feishu_attachment') {
        const descriptor = getBuiltinToolMetadata(args.toolName)!
        feishuMediaFact = await probeFeishuMediaTarget(
          args.userDataDir,
          args.toolInput.attachmentId,
          args.remoteContext?.source === 'feishu' ? args.remoteContext.feishuAttachments : undefined,
          args.remoteContext?.messageId ?? ''
        )
        facts = {
          toolName: descriptor.toolName,
          actionClass: descriptor.actionClass,
          baseRiskLevel: descriptor.riskLevel,
          signals: [{ kind: 'feishu-media-target', boundary: feishuMediaFact.boundary }],
          summary: { text: '飞书附件目标边界已检查' }
        }
      } else if (lane === 'wechat' && (args.toolName === 'wechat_send' || args.toolName === 'wechat_reply')) {
        facts = runExtractors(descriptor, args.toolInput, env)
        const mediaPath = typeof args.toolInput.imagePath === 'string'
          ? args.toolInput.imagePath
          : typeof args.toolInput.filePath === 'string'
            ? args.toolInput.filePath
            : undefined
        if (mediaPath) {
          try {
            const mediaWikiProbe = wikiProbeContext(args, mediaPath)
            wechatMediaPathFact = await probeReadPathFact({
              rawPath: mediaPath,
              workDir: args.workDir,
              userDataDir: args.userDataDir,
              homeDir: os.homedir(),
              customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? [],
              mountAnchors: mediaWikiProbe.mountAnchors,
              sensitiveRootExemptions: mediaWikiProbe.sensitiveRootExemptions
            })
            let workdirScope: 'inside-workdir' | 'outside-workdir' | 'unknown'
            try {
              // media 附件语义保持 workDir 基准：wiki 附件真实路径在 userData → outside-workdir → 门禁拒绝（§13 决议）
              workdirScope = await classifyWriteTargetScope(wechatMediaPathFact.normalizedPath, args.workDir)
            } catch {
              workdirScope = 'unknown'
            }
            const readableTarget = wechatMediaPathFact.targetKind === 'file' ||
              wechatMediaPathFact.targetKind === 'missing' ||
              (wechatMediaPathFact.targetKind === 'symlink' && wechatMediaPathFact.resolvedKind === 'file')
            const boundary = !readableTarget || workdirScope === 'unknown'
              ? 'unknown'
              : workdirScope === 'inside-workdir' ? 'inside-workdir' : 'outside-workdir'
            facts.signals.push({ kind: 'wechat-media-target', boundary, zone: wechatMediaPathFact.zone, targetKind: wechatMediaPathFact.targetKind })
            if (wechatMediaPathFact.targetKind === 'file' && wechatMediaPathFact.identity) {
              facts.signals.push({ kind: 'wechat-media-identity', ...wechatMediaPathFact.identity })
            }
            if ((boundary === 'inside-workdir' || boundary === 'outside-workdir') && wechatMediaPathFact.targetKind === 'file' && wechatMediaPathFact.identity) {
              const resolvedMediaPath = boundary === 'inside-workdir'
                ? await resolveSafeWorkDirPath(args.workDir, mediaPath)
                : wechatMediaPathFact.normalizedPath
              const extension = path.extname(resolvedMediaPath).toLowerCase()
              const imageRequest = typeof args.toolInput.imagePath === 'string'
              // Hashing is needed to bind human approval to the exact attachment. This is
              // not the transport limit; avoid silently treating an unbound file as approved.
              const maxBytes = imageRequest || ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension)
                ? 10 * 1024 * 1024 : 512 * 1024 * 1024
              let mediaBytes: Buffer | undefined
              try {
                const linkStat = await fsPromises.lstat(resolvedMediaPath)
                if (!linkStat.isSymbolicLink() && linkStat.isFile()) {
                  const handle = await fsPromises.open(resolvedMediaPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
                  try {
                    const openedStat = await handle.stat()
                    const expected = wechatMediaPathFact.identity
                    const matches = (stat: typeof openedStat) => stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino &&
                      stat.mode === expected.mode && stat.size === expected.size && stat.mtimeMs === expected.mtimeMs
                    if (matches(openedStat) && openedStat.size <= maxBytes) {
                      const bytes = await handle.readFile()
                      const afterReadStat = await handle.stat()
                      if (matches(afterReadStat) && bytes.byteLength === afterReadStat.size) mediaBytes = bytes
                    }
                  } finally { await handle.close() }
                }
              } catch { /* Missing, replaced, linked or unreadable files stay outside the complete candidate set. */ }
              if (mediaBytes) {
                const contentDigest = createHash('sha256').update(mediaBytes).digest('hex')
                const displayPath = boundary === 'inside-workdir'
                  ? path.relative(args.workDir, resolvedMediaPath).split(path.sep).join('/')
                  : path.basename(resolvedMediaPath)
                facts.signals.push({ kind: 'wechat-media-content',
                  sha256: contentDigest, byteSize: mediaBytes.length,
                  fileName: path.basename(resolvedMediaPath),
                  displayPath })
                let inspectedText = ''
                let inspectionCoverage: 'complete' | 'partial' = 'complete'
                try { inspectedText = new TextDecoder('utf-8', { fatal: true }).decode(mediaBytes) }
                catch { inspectionCoverage = 'partial' }
                const attachmentFacts = await createImAttachmentFacts({
                  fileName: path.basename(resolvedMediaPath),
                  relativePath: displayPath,
                  content: inspectedText,
                  contentDigest,
                  inspectionCoverage
                })
                facts.signals.push({ kind: 'wechat-media-content-assessment', ...attachmentFacts })
                if (mediaBytes.length <= 20_000 && inspectionCoverage === 'complete') {
                  reviewedAttachmentContent = { path: resolvedMediaPath, fileName: path.basename(resolvedMediaPath), content: inspectedText,
                    contentDigest, inspectionCoverage, evidenceKinds: attachmentFacts.evidenceKinds }
                }
              }
            }
            const recipient = typeof args.toolInput.userId === 'string' && args.toolInput.userId.length > 0
              ? args.toolInput.userId
              : args.toolName === 'wechat_reply' && args.remoteContext?.source === 'wechat' ? args.remoteContext.userId : undefined
            const ownerId = args.remoteContext?.source === 'wechat' ? args.remoteContext.authOwner : undefined
            const authorizationGeneration = args.remoteContext?.source === 'wechat' ? args.remoteContext.authorizationGeneration : undefined
            const bindingComplete = Boolean(recipient && ownerId && Number.isInteger(authorizationGeneration) &&
              args.remoteContext?.source === 'wechat' && args.remoteContext.messageId && args.requestId && args.toolUseId)
            facts.signals.push({ kind: 'wechat-media-review-binding', status: bindingComplete ? 'complete' : 'incomplete',
              ...(recipient ? { recipient } : {}), ...(ownerId ? { ownerId } : {}), ...(authorizationGeneration !== undefined ? { authorizationGeneration } : {}),
              ...(args.remoteContext?.source === 'wechat' ? { messageId: args.remoteContext.messageId } : {}),
              ...(args.requestId ? { requestId: args.requestId } : {}), ...(args.toolUseId ? { toolUseId: args.toolUseId } : {}) })
            const contentCoverage = facts.signals.find((signal) => signal.kind === 'wechat-media-content-assessment')
            if (args.imPolicySnapshot?.policyBehaviorVersion === 'im-standard-v3') {
              const reviewMaterialComplete = args.toolName === 'wechat_reply' && boundary === 'outside-workdir' && bindingComplete &&
                Boolean(reviewedAttachmentContent && recipient && ownerId)
              if (reviewMaterialComplete && reviewedAttachmentContent) {
                facts.reviewMaterials = { kind: 'wechat-attachment', path: reviewedAttachmentContent.path, fileName: reviewedAttachmentContent.fileName,
                  recipient, ownerId, content: reviewedAttachmentContent.content, contentDigest: reviewedAttachmentContent.contentDigest,
                  inspectionCoverage: reviewedAttachmentContent.inspectionCoverage, evidenceKinds: reviewedAttachmentContent.evidenceKinds, complete: true }
              }
              facts.signals.push({ kind: 'approval-review-materials', status: reviewMaterialComplete ? 'complete' : 'incomplete' })
            }
            facts.signals.push({ kind: 'wechat-media-review-materials',
              status: boundary === 'outside-workdir' && wechatMediaPathFact.targetKind === 'file' && contentCoverage?.inspectionCoverage === 'complete' && bindingComplete
                ? 'complete' : 'incomplete' })
          } catch (error) {
            if (!(error instanceof ReadPathProbeError)) throw error
            facts.signals.push({ kind: 'wechat-media-target', boundary: 'unknown', targetKind: 'unknown' })
            facts.signals.push({ kind: 'extraction-failed', reason: error.caseId })
          }
        }
      } else {
        facts = runExtractors(descriptor, args.toolInput, env, {
          ...(lane === 'feishu' && args.remoteContext?.authOwner ? { trustedFeishuActorOpenId: args.remoteContext.authOwner } : {})
        })
      }
    } else if (args.registeredActionClass) {
      facts = {
        toolName: args.toolName,
        actionClass: args.registeredActionClass,
        baseRiskLevel: args.registeredActionClass === 'read' ? 'low' : args.registeredActionClass === 'write' ? 'medium' : 'high',
        signals: [],
        summary: { text: `${args.toolName} 已由注册契约声明为 ${args.registeredActionClass}` }
      }
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

  if (args.toolName === 'run_shell' && facts) {
    facts.signals.push(...shellPathSignals)
    // facts: report whether the frozen receipt matches the exact command text, arguments and cwd; policy rules decide the outcome.
    if (lane === 'automation') {
      const command = typeof args.toolInput.command === 'string' ? args.toolInput.command : ''
      const requestedWorkingDirectory = typeof args.toolInput.workingDirectory === 'string' ? args.toolInput.workingDirectory : undefined
      const receiptWorkingDirectory = resolveAutomationShellWorkingDirectory(args.taskAccessPermissions, command, requestedWorkingDirectory)
      const matchesCallDirectory = receiptWorkingDirectory !== undefined && path.resolve(receiptWorkingDirectory) === path.resolve(args.workDir)
      facts.signals.push({ kind: 'automation-shell-permission', status: matchesCallDirectory ? 'matched' : 'missing' })
    }
  }
  if (args.toolName === 'grep' && facts) {
    const searchPath = readPathFact?.normalizedPath ?? ''
    if (lane === 'automation') facts.signals.push({ kind: 'automation-grep-permission', status: matchAutomationGrepPermission(args.taskAccessPermissions, searchPath) ? 'matched' : 'missing' })
    const pattern = typeof args.toolInput.pattern === 'string' ? args.toolInput.pattern : ''
    facts.signals.push({ kind: 'grep-invocation', path: searchPath, pattern,
      ...(typeof args.toolInput.glob === 'string' ? { glob: args.toolInput.glob } : {}),
      ...(typeof args.toolInput.output_mode === 'string' ? { outputMode: args.toolInput.output_mode } : {}),
      ...(typeof args.toolInput.ignore_case === 'boolean' ? { ignoreCase: args.toolInput.ignore_case } : {}),
      ...(typeof args.toolInput.include_ignored === 'boolean' ? { includeIgnored: args.toolInput.include_ignored } : {}),
      ...(typeof args.toolInput.multiline === 'boolean' ? { multiline: args.toolInput.multiline } : {}),
      ...(typeof args.toolInput.context === 'number' ? { context: args.toolInput.context } : {}),
      ...(typeof args.toolInput.head_limit === 'number' ? { headLimit: args.toolInput.head_limit } : {}),
      ...(typeof args.toolInput.timeout === 'number' ? { timeoutSeconds: args.toolInput.timeout } : {})
    })
  }
  if (args.toolName === 'run_script' && facts && lane === 'automation') {
    const observedPaths = facts.signals.flatMap((signal) => signal.kind === 'path-target' ? [signal.path] : [])
    facts.signals.push({ kind: 'automation-script-permission', status: matchAutomationScriptPermission(args.taskAccessPermissions, args.workDir, observedPaths) ? 'matched' : 'missing' })
  }
  // facts: report whether this generic filesystem invocation targets the mounted Wiki and whether its lifecycle is enabled.
  if (facts && args.wikiConfig && ['read_file', 'list_directory', 'grep', 'write_file', 'edit_file', 'run_shell'].includes(args.toolName)) {
    const rawPaths = args.toolName === 'run_shell'
      ? shellPathSignals.flatMap((signal) => signal.kind === 'path-target' ? [signal.path] : [])
      : [extractPathField(args.toolInput)].filter((value): value is string => typeof value === 'string' && value.length > 0)
    const mounts = rawPaths.map((rawPath) => resolveWikiMount(args.workDir, args.wikiConfig!, args.userDataDir, rawPath)).filter((mount) => mount.mounted)
    if (mounts.length) {
      facts.signals.push({ kind: 'wiki-managed-target' })
      const lifecycle = await createWikiLifecycleController(mounts[0]!.realBase).read().catch(() => undefined)
      if (lifecycle?.lifecycle === 'domain_enabled') facts.signals.push({ kind: 'wiki-domain-enabled' })
    }
  }
  // ===== R5：shell unsupported 事实下传（gate 层零特例——不派发 desktop 规则，照常进引擎）=====
  if (args.toolName === 'run_shell' && result.shellPrecheck) {
    const analysis = result.shellPrecheck.analysis
    if (analysis.verdict === 'unsupported') {
      facts = {
        ...facts,
        signals: [
          ...facts.signals,
          {
            kind: 'shell-unsupported-structure',
            structures: analysis.unsupportedStructures ?? [],
            reason: analysis.unsupportedReason ?? 'structure'
          }
        ]
      }
    }
  }

  // ===== 执行上下文（预算/授权只读 peek；记账留主循环）=====
  const context: ExecutionContext = { lane, origin, sessionId: args.sessionId, policyTier: args.lanePackage ?? 'standard' }
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
    deniedTools: args.toolsConfig.deniedTools,
    allowDeclaredPathScopeScripts: args.toolsConfig.allowDeclaredPathScopeScripts === true,
    remoteDenyOutbound: args.imPolicySnapshot?.snapshot.remoteDenyOutbound === true || args.imPolicySnapshot?.snapshot.denyOutbound === true,
    // 现状仅在 browserConfig 存在且未开放远程会话时阻断；无配置等价放行
    allowRemoteSessions: args.browserConfig ? (args.browserConfig.allowRemoteSessions ?? false) : true,
    remoteScriptRequiresConfirm: args.imPolicySnapshot?.snapshot.remoteScriptRequiresConfirm !== false,
    navigateRequiresConfirm: args.browserConfig?.navigateRequiresConfirm ?? true,
    remoteNavigateRequiresConfirm: args.imPolicySnapshot?.snapshot.remoteBrowserNavigateRequiresConfirm !== false,
    actRequiresConfirm: args.browserConfig?.actRequiresConfirm ?? true,
    remoteActSkipConfirm: shouldSkipRemoteBrowserActConfirm({ policySnapshot: args.imPolicySnapshot }),
    larkCliWriteRequiresConfirm: args.imPolicySnapshot?.snapshot.larkCliWriteRequiresConfirm !== false
  }

  // ===== 决策（缓存走 AuditedDecisionCache，落 cache.hit 审计）=====
  // 底层视图由装配期注入（B1）；审计装饰仍在此完成，保证 args.audit 注入语义不变
  const cache: DecisionCacheView = new AuditedDecisionCache({
    cache: (lane === 'desktop' && (args.toolName === 'read_file' || args.toolName === 'grep' || args.toolName === 'list_directory')) ||
      (writePathFact !== undefined && writePathFact.zone !== 'workdir-normal') ||
      facts.signals.some((signal) => signal.kind === 'wechat-media-target' && signal.boundary !== 'inside-workdir') ||
      (args.toolName === 'run_shell' && shellPathSignals.some((signal) => signal.kind === 'path-target' && signal.zone !== 'workdir-normal'))
      ? { ...args.decisionCache, lookup: () => null }
      : args.decisionCache,
    audit,
    sessionId: args.sessionId,
    lane,
    origin
  })
  // P5（偏差 4）AutoEvaluator 数据化：预过滤器路由由生效规则数据驱动（action='auto-evaluator'
  // 条目的 match.toolName + match.lane 声明评估域与 lane 标注），不再是按工具名写死的代码分支。
  // 确定性预过滤地位保留在回答者之前（审批计划已拍板，复核记录留痕）。
  const autoEvaluatorRoutes = new Map<string, string>()
  if (lane === 'desktop' && (args.phase !== 'recheck' || args.evaluateFastTrackOnRecheck)) {
    // §2.3：「自动」动作的内建快通道——desktop 下 write_file/edit_file 恒注册（不依赖基线规则，
    // desktop-auto-approve 规则已删；custom 覆盖为 ask 时规则动作不再消费评估器，路由天然旁路）
    autoEvaluatorRoutes.set('write_file', 'file-fast-track')
    autoEvaluatorRoutes.set('edit_file', 'file-fast-track')
  }
  for (const rule of rules) {
    if (rule.action !== 'auto-evaluator') continue
    const laneMatch = rule.match?.lane
    if (laneMatch && !laneMatch.includes(lane)) continue
    const names = rule.match?.toolName === undefined
      ? []
      : Array.isArray(rule.match.toolName)
        ? rule.match.toolName
        : [rule.match.toolName]
    for (const name of names) autoEvaluatorRoutes.set(name, rule.id)
  }
  const reviewScopeCandidate = await buildReviewScopeCandidate(args, lane, writePathFact, readPathFact)
  let reviewScopeEntry = reviewScopeCandidate ? args.reviewScopeCache?.lookup(reviewScopeCandidate) : null
  if (reviewScopeCandidate && reviewScopeEntry?.receipt && writePathFact && !await verifyReviewFileReceipt(writePathFact.normalizedPath, reviewScopeEntry.receipt)) {
    args.reviewScopeCache?.revoke(reviewScopeCandidate)
    reviewScopeEntry = null
  }
  const reviewScopeGrant = reviewScopeEntry ? { source: reviewScopeEntry.source } : undefined
  const deps: PolicyEngineDeps = {
    cache,
    config,
    migrationComplete: isRemoteSecurityMigrationComplete({ policySnapshot: args.imPolicySnapshot }),
    ...(reviewScopeGrant ? { reviewScopeGrant } : {}),
    // 档位动作变换（§2.1）：引擎合成规则（default-write-execute-ask）经同源变换参与「自动」
    transform: (r) => effectiveActionFor(lane, lanePackage, r),
    autoEvaluator: (f) => {
      const route = autoEvaluatorRoutes.get(f.toolName)
      if (!route) return { approve: false as const, reason: '无评估器' }
      if (route === 'shell-precheck-auto-allow') {
        return shellLegacyAutoAllowEligible || shellOutsideReadOnly
          ? { approve: true as const, reason: 'shell-precheck' }
          : { approve: false as const, reason: 'shell-precheck 未放行' }
      }
      if (route === 'file-fast-track') {
        return fileAutoApprove === true
          ? { approve: true as const, reason: 'file-fast-track' }
          : { approve: false as const, reason: '文件自动审批未通过' }
      }
      return { approve: false as const, reason: '无评估器' }
    }
  }
  // P5：factsProvider 补充并入（工具契约 ∪ 宿主环境，逐项标注来源半区）
  let providerSignals: import('../../src/shared/confirmation/types').FactSignal[] | undefined
  if (args.factsProvider) {
    providerSignals = args.factsProvider({ toolName: args.toolName, toolInput: args.toolInput })
  }
  if (args.toolName === 'switch_work_dir' && !args.factsProvider) {
    providerSignals = [{ kind: 'workdir-profile-target', status: 'unknown' }]
  }
  const factSources: Record<string, 'tool-contract' | 'host-environment'> = {}
  for (const signal of facts.signals) factSources[signal.kind] = 'tool-contract'
  for (const signal of providerSignals ?? []) {
    if (!(signal.kind in factSources)) factSources[signal.kind] = 'host-environment'
  }
  facts.signals = [...facts.signals, ...(providerSignals ?? [])]
  const wechatMediaTarget = facts.signals.find((signal) => signal.kind === 'wechat-media-target' && signal.boundary === 'outside-workdir')
  // facts phase: a directory-external standard reply is reviewable only when the
  // gate's host read is the same immutable material the registered executor prepared.
  if (lane === 'wechat' && wechatMediaTarget) {
    const hostAttachment = facts.signals.find((signal) => signal.kind === 'wechat-media-content-assessment')
    const preparedAttachments = (providerSignals ?? []).filter((signal) => signal.kind === 'wechat-media-content-assessment')
    const preparedDigest = preparedAttachments.length === 1 ? preparedAttachments[0]!.contentDigest : undefined
    const materials = facts.signals.find((signal) => signal.kind === 'wechat-media-review-materials')
    const standardReplyCandidate = args.toolName === 'wechat_reply' && lanePackage === 'standard'
    const hasSensitiveEvidence = hostAttachment?.evidenceKinds.length
    if (standardReplyCandidate && !hasSensitiveEvidence && materials?.kind === 'wechat-media-review-materials' &&
      (!hostAttachment || preparedDigest !== hostAttachment.contentDigest)) {
      materials.status = 'incomplete'
      const approvalMaterials = facts.signals.find((signal) => signal.kind === 'approval-review-materials')
      if (approvalMaterials?.kind === 'approval-review-materials') approvalMaterials.status = 'incomplete'
      facts.reviewMaterials = undefined
    }
  }
  const reviewCandidateSignal = facts.signals.find((signal) =>
    signal.kind === 'im-script-network-review-candidate' || signal.kind === 'im-shell-review-candidate' ||
    signal.kind === 'write-target-new' || signal.kind === 'write-target-existing')
  if (args.imPolicySnapshot?.policyBehaviorVersion === 'im-standard-v3' && reviewCandidateSignal && !facts.signals.some((signal) => signal.kind === 'approval-review-materials')) {
    const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')
    let reviewMaterials: import('../../src/shared/confirmation/types').ApprovalReviewMaterials | undefined
    let complete = false
    if ((args.toolName === 'write_file' || args.toolName === 'edit_file') &&
      facts.signals.some((signal) => signal.kind === 'write-target-scope' && signal.scope === 'outside-workdir')) {
      const target = typeof args.toolInput.path === 'string' ? args.toolInput.path : undefined
      if (args.toolName === 'write_file') {
        const content = typeof args.toolInput.content === 'string' ? args.toolInput.content : undefined
        complete = Boolean(target && content !== undefined && byteLength(content) <= REVIEW_MATERIAL_MAX_BYTES)
        if (target && content !== undefined && byteLength(content) <= REVIEW_MATERIAL_MAX_BYTES) {
          reviewMaterials = { kind: 'outside-file-write', operation: 'new', target, content, complete }
        }
      } else {
        const oldText = typeof args.toolInput.old_string === 'string' ? args.toolInput.old_string : undefined
        const replacementText = typeof args.toolInput.new_string === 'string' ? args.toolInput.new_string : undefined
        const replaceAll = Boolean(args.toolInput.replace_all)
        const tolerateEscapeLayer = args.toolInput.tolerate_escape_layer === true
        if (target && oldText !== undefined && replacementText !== undefined) {
          const editReview = await createOutsideEditReviewFields({ targetFact: writePathFact, target, oldText, replacementText, replaceAll, tolerateEscapeLayer })
          complete = editReview.complete
          reviewMaterials = { kind: 'outside-file-write', operation: 'edit', target, ...editReview }
        }
      }
    } else if (reviewCandidateSignal.kind === 'im-shell-review-candidate') {
      const plan = args.preparedShellReview
      complete = Boolean(plan && plan.behaviorCoverage === 'complete' && plan.command === args.toolInput.command &&
        byteLength(plan.command) <= 20_000 && plan.cwd && plan.shell && plan.environmentFingerprint && plan.planDigest && Number.isFinite(plan.timeoutSeconds))
      if (plan) reviewMaterials = { kind: 'git-query', command: plan.command, cwd: plan.cwd, timeoutSeconds: plan.timeoutSeconds,
        shell: plan.shell, environmentKeys: plan.environmentKeys, environmentFingerprint: plan.environmentFingerprint,
        planDigest: plan.planDigest, behaviorCoverage: plan.behaviorCoverage, complete }
    } else if (reviewCandidateSignal.kind === 'im-script-network-review-candidate') {
      const code = typeof args.toolInput.code === 'string' ? args.toolInput.code : ''
      const settings = facts.signals.find((signal) => signal.kind === 'script-execution-settings')
      const environment = facts.signals.find((signal) => signal.kind === 'script-execution-environment')
      const configuredInterpreter = args.toolsConfig.pythonPath?.trim() || 'python'
      const interpreterFallbackCandidates = configuredInterpreter === 'python'
        ? process.platform === 'win32' ? ['py', 'python3'] : ['python3'] : []
      const timeoutSeconds = typeof args.toolInput.timeout === 'number' ? args.toolInput.timeout : args.toolsConfig.scriptTimeout
      const cwd = path.resolve(args.workDir)
      complete = byteLength(code) <= REVIEW_MATERIAL_MAX_BYTES && settings?.kind === 'script-execution-settings' &&
        environment?.kind === 'script-execution-environment' && cwd.length > 0 && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      if (byteLength(code) <= REVIEW_MATERIAL_MAX_BYTES && settings?.kind === 'script-execution-settings' && environment?.kind === 'script-execution-environment') {
        reviewMaterials = { kind: 'static-network-script', code, url: reviewCandidateSignal.url, host: reviewCandidateSignal.host,
          method: reviewCandidateSignal.method, interpreter: configuredInterpreter, interpreterFallbackCandidates, cwd, timeoutSeconds,
          interpreterResolution: interpreterFallbackCandidates.length > 0 ? 'first-version-probe-success' : 'configured-command',
          settingsDigest: settings.digest, environmentDigest: environment.digest, complete }
      }
    }
    facts.reviewMaterials = reviewMaterials
    facts.signals.push({ kind: 'approval-review-materials', status: complete && reviewMaterials?.complete ? 'complete' : 'incomplete' })
  }
  facts.signals.push({ kind: 'policy-tier', tier: lanePackage })
  facts.factSources = factSources
  facts.factsProviderDeclared = args.factsProvider !== undefined

  // 写路径事实必须先于桌面写快通道。快通道只能消费已探测事实，不能自行重做路径分类。
  let fileAutoApprove: boolean | undefined
  if ((args.phase !== 'recheck' || args.evaluateFastTrackOnRecheck) && lane === 'desktop' && (args.toolName === 'write_file' || args.toolName === 'edit_file')) {
    if (writePathProbeFailure) {
      result.autoApproveFallback = { reason: '写入目标事实探测失败', reasonCode: 'write_path_probe_failed' }
    } else {
      const autoEval = await (args.fileAutoApproval ?? evaluateFileToolAutoApproval)({
        workDir: args.workDir,
        userDataDir: args.userDataDir,
        toolsConfig: args.toolsConfig,
        shellConfig: args.shellConfig,
        toolName: args.toolName,
        input: args.toolInput,
        ...(writePathFact ? { writePathFact } : {})
      })
      const targetMayUseFastTrack = args.toolName === 'write_file' && writePathFact?.zone === 'workdir-normal' && writePathFact.targetKind === 'missing'
      fileAutoApprove = autoEval.approve && targetMayUseFastTrack
      if (!fileAutoApprove) {
        const outOfWorkDir = writePathFact !== undefined && writePathFact.zone !== 'workdir-normal'
        const unsafeTarget = writePathFact !== undefined && !targetMayUseFastTrack
        result.autoApproveFallback = {
          reason: outOfWorkDir ? '写入目标位于工作目录之外，需进入确认流程' : unsafeTarget ? '写入目标类型不支持自动放行' : autoEval.approve ? '目标未通过写入安全边界' : autoEval.reason,
          reasonCode: outOfWorkDir ? (writePathFact?.zone === 'sensitive-file' ? 'sensitive_path' : 'outside_workdir') : unsafeTarget || autoEval.approve ? 'unsafe_target' : autoEval.reasonCode
        }
      }
    }
  }

  // 生效规则集已在上方加载（自动审批预计算依赖），此处直接判定
  const isReadTool = args.toolName === 'read_file' || args.toolName === 'grep'
  const isListDirectoryTool = args.toolName === 'list_directory'
  const isPermitReadTool = isReadTool || isListDirectoryTool
  // grep 与 list_directory 一致：path 缺省视为工作目录根（'.'）——grep 递归搜索能力释放 §7.4 改动 1
  const explicitReadPath = isReadTool || isListDirectoryTool ? (extractPathField(args.toolInput) ?? '.') : undefined
  const readHasUnsupportedPattern = explicitReadPath !== undefined && hasUnsupportedV1ReadTarget(args.toolName, args.toolInput)
  const desktopReadValidation = lane === 'desktop' && isReadTool
    ? validateDesktopReadV1({ facts, context, zone: readPathFact?.zone, targetKind: readPathFact?.targetKind, hasExplicitPath: explicitReadPath !== undefined, hasUnsupportedPattern: readHasUnsupportedPattern })
    : undefined
  const directoryReadValidation = isListDirectoryTool
    ? !readPathFact || readPathFact.scope !== 'direct-entries-snapshot' || !(readPathFact.targetKind === 'directory' || (readPathFact.targetKind === 'symlink' && readPathFact.resolvedKind === 'directory'))
      ? { type: 'deny' as const, ruleId: 'directory-read-target-unsupported', reason: '目录读取仅支持存在的目录目标' }
      : undefined
    : undefined
  // read_file：文件或 missing；grep：文件或目录均可，missing 允许（由 permit 层报 read-target-missing）——§7.4 改动 2
  const isResolvedDirectory = readPathFact?.targetKind === 'directory' ||
    (readPathFact?.targetKind === 'symlink' && readPathFact.resolvedKind === 'directory')
  const isResolvedFile = readPathFact?.targetKind === 'file' ||
    (readPathFact?.targetKind === 'symlink' && readPathFact.resolvedKind === 'file')
  const fileReadValidation = args.toolName === 'read_file' && readPathFact &&
    !(['file', 'missing'].includes(readPathFact.targetKind) || isResolvedFile)
    ? { type: 'deny' as const, ruleId: 'read-v1-target-unsupported', reason: 'read_file 仅支持单个普通文件目标' }
    : undefined
  const grepReadValidation = args.toolName === 'grep' && readPathFact &&
    !(['file', 'missing'].includes(readPathFact.targetKind) || isResolvedFile || isResolvedDirectory)
    ? { type: 'deny' as const, ruleId: 'read-v1-target-unsupported', reason: 'grep 搜索根仅支持文件或目录' }
    : undefined
  // 通配/多路径抢先于 unknown 染色给出准确原因与可操作指引——§7.4 改动 5（AC-25 依赖，不可选）
  const readPatternValidation = readHasUnsupportedPattern
    ? { type: 'deny' as const, ruleId: 'read-path-pattern-unsupported', reason: 'path 只接受文件或目录路径；文件名过滤请改用 glob 参数（如 glob:"*.ts"），通配路径与多路径不受支持' }
    : undefined
  const selectedDirectoryGrant = readPathFact && lane === 'desktop' && args.sessionDirectoryGrants &&
    readPathFact.zone === 'outside-workdir' && isPermitReadTool
    ? await matchSessionDirectoryGrant({ grants: args.sessionDirectoryGrants, sessionId: args.sessionId, lane, targetPath: readPathFact.normalizedPath })
    : undefined
  let decision: Decision = writePathInputFailure
    ? { type: 'deny' as const, ruleId: 'write-path-input-invalid', reason: '缺少有效的路径参数，已阻止写入' }
    : wikiRawTargetFailure
    ? { type: 'deny' as const, ruleId: 'wiki-raw-write-deny', reason: 'Wiki 原始文件目标禁止由模型直接写入' }
    : writePathProbeFailure
    ? { type: 'deny' as const, ruleId: writePathProbeFailure.caseId, reason: '写入目标事实探测失败，已阻止执行' }
    : readPathProbeFailure
    ? { type: 'deny' as const, ruleId: readPathProbeFailure.caseId, reason: '读取目标事实探测失败，已阻止执行' }
    : readPatternValidation
    ? readPatternValidation
    : directoryReadValidation
    ? directoryReadValidation
    : fileReadValidation
    ? fileReadValidation
    : grepReadValidation
    ? grepReadValidation
    : desktopReadValidation
    ? desktopReadValidation
    : lane === 'automation' && isReadTool && (!readPathFact || readHasUnsupportedPattern)
      ? { type: 'deny' as const, ruleId: 'automation-read-target-unsupported', reason: 'automation lane 仅支持显式、单目标文件或目录读取', disposition: 'forbidden' as const, cause: 'automation-read-target-unsupported' }
      : decide(facts, context, rules, deps)

  // P2-04 / P2-07: scope and precheck affect the decision only through matched rules or evaluator evidence.

  // ===== P2-4 递归守卫（I5）：审批会话内的 require-confirm 一律 fail-closed =====
  // 守卫在回答者解析之前生效，否则内层 require-confirm 会被再次解析到 AgentChannel 造成递归。
  // 不可进规则集：进规则集就会被 custom/loose 改坏，收紧致自动审批静默停摆（不可变集，非 locked 底线集）。
  if (decision.type === 'require-confirm' && args.internalConfirmExemption === 'approval-agent') {
    const reason = '安全策略无法完成裁决：审批会话内不允许再进入确认流程（递归守卫）'
    decision = { type: 'deny', ruleId: 'recursion-guard', reason, disposition: 'forbidden', cause: 'recursion-guard' }
  }

  if (args.phase === 'recheck' && decision.type === 'require-confirm' && !args.previouslyConfirmed) {
    decision = { type: 'deny', ruleId: 'recheck-requires-confirm', reason: '确认后复检不得发起第二次确认' }
  }

  // 目录目标可签发 permit 的工具：list_directory（direct-entries）与 grep（subtree）——§7.4 改动 4
  const directoryPermittable = isListDirectoryTool || args.toolName === 'grep'

  if (readPathFact && isPermitReadTool && (decision.type === 'auto-allow' || (decision.type === 'require-confirm' && (decision.answerer === 'user' || decision.answerer === 'agent'))) && (readPathFact.targetKind !== 'directory' || directoryPermittable)) {
    const readTarget = { factId: `fact-${readPathFact.normalizedPath}`, decisionRuleId: decision.ruleId }
    result.readTargetMapping = [readTarget]
    if (decision.type === 'auto-allow') result.approvedFactIds = [readTarget]
  }

  if (args.phase !== 'recheck' && readPathFact && isPermitReadTool && decision.type === 'auto-allow' && (readPathFact.targetKind !== 'directory' || directoryPermittable)) {
    // targetKind 归一：symlink→directory 也表达为 directory；grep 目录签 subtree scope——§7.4 改动 4
    const permitTargetKind = (isListDirectoryTool || args.toolName === 'grep') && isResolvedDirectory ? 'directory' as const : readPathFact.targetKind
    const permitScope: ReadPermitScope | undefined = isListDirectoryTool
      ? 'direct-entries'
      : args.toolName === 'grep' && permitTargetKind === 'directory'
        ? 'subtree'
        : undefined
    result.readExecutionPermit = buildReadExecutionPermit({
      requestId: args.requestId ?? args.sessionId,
      toolUseId: args.toolUseId ?? args.toolName,
      toolName: args.toolName as 'read_file' | 'grep' | 'list_directory',
      decisionRuleId: decision.ruleId,
      input: args.toolInput,
      facts: [{ factId: `fact-${readPathFact.normalizedPath}`, decisionRuleId: decision.ruleId, normalizedPath: readPathFact.normalizedPath, zone: readPathFact.zone, targetKind: permitTargetKind, ...(permitScope ? { scope: permitScope } : {}), ...(readPathFact.resolvedKind ? { resolvedKind: readPathFact.resolvedKind } : {}), ...(readPathFact.identity ? { identity: readPathFact.identity } : {}), ...(readPathFact.vocabularyPath ? { vocabularyPath: readPathFact.vocabularyPath } : {}), ...(selectedDirectoryGrant ? { directoryGrant: { grantId: selectedDirectoryGrant.grantId, sessionId: selectedDirectoryGrant.sessionId, realPath: selectedDirectoryGrant.realPath, identity: selectedDirectoryGrant.identity } } : {}) }]
    })
  } else if (args.phase !== 'recheck' && readPathFact && decision.type === 'require-confirm' && decision.answerer === 'user' && (readPathFact.targetKind !== 'directory' || directoryPermittable)) {
    const registry = args.readConfirmationRegistry ?? readConfirmationRegistry
    const registration = {
      requestId: args.requestId ?? args.sessionId,
      toolUseId: args.toolUseId ?? args.toolName,
      inputDigest: readInputDigest(args.toolInput),
      factIds: [`fact-${readPathFact.normalizedPath}`],
      ruleId: decision.ruleId,
      expiresAt: Date.now() + (decision.timeoutMs ?? DEFAULT_USER_CONFIRMATION_TIMEOUT_MS)
    }
    // policy: deferred re-evaluation may reuse the original live registration only when every bound fact is unchanged.
    const registered = registry.register(registration) || registry.matchesPending(registration)
    if (!registered) decision = { type: 'deny', ruleId: 'read-confirmation-registration-failed', reason: '无法建立本次读取确认登记，已阻止执行' }
  }

  if (feishuMediaFact?.boundary === 'inside' && feishuMediaFact.targetKind === 'file' && feishuMediaFact.normalizedPath && feishuMediaFact.identity && (decision.type === 'auto-allow' || (decision.type === 'require-confirm' && args.phase !== 'recheck'))) {
    const factId = `fact-${feishuMediaFact.normalizedPath}`
    const readTarget = { factId, decisionRuleId: decision.ruleId }
    result.readTargetMapping = [readTarget]
    if (decision.type === 'auto-allow') result.approvedFactIds = [readTarget]
    else if (decision.type === 'require-confirm') {
      const registry = args.readConfirmationRegistry ?? readConfirmationRegistry
      const registration = {
        requestId: args.requestId ?? args.sessionId,
        toolUseId: args.toolUseId ?? args.toolName,
        inputDigest: readInputDigest(args.toolInput),
        factIds: [factId],
        ruleId: decision.ruleId,
        expiresAt: Date.now() + (decision.timeoutMs ?? DEFAULT_USER_CONFIRMATION_TIMEOUT_MS)
      }
      // policy: attachment confirmation follows the same exact-registration rule as file reads.
      const registered = registry.register(registration) || registry.matchesPending(registration)
      if (!registered) decision = { type: 'deny', ruleId: 'read-confirmation-registration-failed', reason: '无法建立本次附件读取确认登记，已阻止执行' }
    }
  }

  if (args.toolName === 'read_feishu_attachment' && feishuMediaFact?.boundary === 'inside' && feishuMediaFact.targetKind === 'file' && feishuMediaFact.normalizedPath && feishuMediaFact.identity && decision.type === 'auto-allow') {
    const factId = `fact-${feishuMediaFact.normalizedPath}`
    result.readExecutionPermit = buildReadExecutionPermit({
      requestId: args.requestId ?? args.sessionId,
      toolUseId: args.toolUseId ?? args.toolName,
      toolName: 'read_feishu_attachment',
      decisionRuleId: decision.ruleId,
      input: args.toolInput,
      facts: [{ factId, decisionRuleId: decision.ruleId, normalizedPath: feishuMediaFact.normalizedPath, zone: 'outside-workdir', targetKind: 'file', identity: feishuMediaFact.identity }]
    })
  }


  // ===== R2：结构化诊断（deny / require-confirm 与 decision 成对；路径事实经脱敏） =====
  if (decision.type === 'deny' || decision.type === 'require-confirm') {
    const ruleDenyClass =
      rules.find((r) => r.id === decision.ruleId)?.denyClass ??
      (args.effectiveRules.find((r) => r.id === decision.ruleId)?.denyClass)
    const targets = facts.signals
      .filter((sig) => sig.kind === 'path-target')
      .map((sig) => {
        const p = (sig as { path: string }).path
        return {
          raw: sanitizeAgentText(p).text,
          resolved: sanitizeAgentText(p).text,
          zone: (sig as { zone: import('../../src/shared/confirmation/types').PathZone }).zone
        }
      })
    const diagnostics = buildSafetyDiagnostics({
      ruleId: decision.ruleId,
      ruleSource: args.policyOrigins?.[decision.ruleId]?.source,
      ruleDenyClass,
      workspace: args.workspace,
      workDir: args.workDir,
      targets,
      ...(decision.type === 'deny' ? { cause: 'rules-violated' as const } : {})
    })
    result.diagnostics = diagnostics
  }

  // 判定即记录（§5.6）：policy.decision 事件
  if (lane === 'desktop' && (args.toolName === 'write_file' || args.toolName === 'edit_file')) {
    audit.record({
      ts: Date.now(), event: 'file.auto-approve', lane, sessionId: args.sessionId,
      requestId: args.requestId, toolUseId: args.toolUseId, toolName: args.toolName,
      pathZone: writePathFact?.zone, autoApproveOutcome: fileAutoApprove === true && decision.type === 'auto-allow' ? 'approved' : 'fallback',
      autoApproveReasonCode: result.autoApproveFallback?.reasonCode ?? (decision.type === 'deny' ? decision.ruleId : 'approval-required'),
      reason: result.autoApproveFallback?.reason ?? (decision.type === 'deny' ? decision.reason : '需要既有确认流程'),
      actor: 'system'
    })
  }
  const reportedCompleteness = facts.signals.flatMap((signal) => {
    if (signal.kind === 'mcp-invocation') return [signal.completeness]
    if (signal.kind === 'browser-action' || signal.kind === 'lark-subcommand') return signal.completeness ? [signal.completeness] : []
    return []
  })
  const factsCompleteness = reportedCompleteness.includes('missing') ? 'missing'
    : reportedCompleteness.includes('partial') ? 'partial'
      : reportedCompleteness.includes('capability-description-stale') ? 'capability-description-stale'
        : reportedCompleteness.length > 0 && reportedCompleteness.every((value) => value === 'complete') ? 'complete' : 'unknown'
  const reportedSnapshotCompleteness = facts.signals.some((signal) => signal.kind === 'mcp-invocation' && signal.completeness === 'missing')
    ? 'missing' as const
    : facts.signals.some((signal) => signal.kind === 'mcp-invocation' && signal.completeness === 'capability-description-stale')
      ? 'capability-description-stale' as const
      : facts.signals.some((signal) => signal.kind === 'extraction-failed' ||
          signal.kind === 'shell-analysis-completeness' && signal.completeness === 'partial' ||
          signal.kind === 'mcp-invocation' && signal.completeness === 'partial')
        ? 'partial' as const
        : 'complete' as const
  const factsSnapshot = await createInvocationFactsSnapshot({
    invocationId: args.requestId ?? args.sessionId,
    envelope: { toolName: args.toolName, toolInput: args.toolInput, toolUseId: args.toolUseId ?? '' },
    facts,
    extractorVersion: 'host-tool-facts-v1',
    completeness: reportedSnapshotCompleteness,
    evidenceReferences: [],
    environmentVersion: `${env.os}:${env.workDir}`,
    policyVersion: args.policyBinding?.policyBehaviorVersion ?? args.imPolicySnapshot?.policyBehaviorVersion ?? 'desktop-policy-v1',
    factsRevision: args.phase === 'recheck' ? 2 : 1,
    previousFactsRevision: 0
  })
  result.factsSnapshot = factsSnapshot
  if (reviewScopeCandidate && args.reviewScopeCache) {
    try {
      result.reviewScopeCandidate = {
        scopeCandidateDigest: args.reviewScopeCache.candidateDigest(reviewScopeCandidate),
        toolName: reviewScopeCandidate.toolName, operation: reviewScopeCandidate.operation,
        objects: reviewScopeCandidate.objects.map(({ role, value }) => ({ role, target: value }))
      }
      result.reviewScopeCandidateScope = reviewScopeCandidate
      result.reviewScopeCandidateDigest = result.reviewScopeCandidate.scopeCandidateDigest
    } catch { /* Invalid evidence disables the optimization. */ }
  }
  const policyDomain = lane === 'wechat' || lane === 'feishu' ? 'im' : lane === 'automation' ? 'automation' : 'desktop'
  const policyDecision = createPolicyDecision({
    decision, invocationId: args.requestId ?? args.sessionId, toolUseId: args.toolUseId ?? args.requestId ?? args.sessionId,
    factsId: factsSnapshot.factId, factsDigest: factsSnapshot.factsHash, extractorVersion: factsSnapshot.extractorVersion,
    factsRevision: factsSnapshot.factsRevision, policyDomain, tier: lanePackage,
    policyVersion: args.policyBinding?.policyBehaviorVersion ?? args.imPolicySnapshot?.policyBehaviorVersion ?? 'desktop-policy-v1',
    policyRevision: args.policyBinding?.revision ?? args.imPolicySnapshot?.revision ?? 0, policyLane: lane, rules,
    dependencyRules: selectPolicyDependencyRules({
      rules,
      matchingRuleIds: rules.filter((rule) => rule.when === 'invocation' && ruleMatchesInvocation(rule,
        context.policyTier ? { ...facts, signals: [...facts.signals, { kind: 'policy-tier' as const, tier: context.policyTier }] } : facts,
        context, deps)).map((rule) => rule.id),
      decisionRuleIds: [decision.ruleId]
    }),
    policyConfig: {
      ...deps.config,
      ...(facts.actionClass === 'write' ? {
        writeApprovalConfiguration: {
          workDir: args.workDir,
          userDataDir: args.userDataDir,
          toolsConfig: {
            autoApproveMaxBytes: args.toolsConfig.autoApproveMaxBytes,
            autoApproveMaxEditChars: args.toolsConfig.autoApproveMaxEditChars
          },
          shellConfig: args.shellConfig ?? null,
          wikiConfig: args.wikiConfig ?? null
        }
      } : {})
    }, migrationComplete: deps.migrationComplete,
    disabledRuleIds: []
  })
  if (result.readExecutionPermit) {
    result.readExecutionPermit = buildReadExecutionPermit({
      ...result.readExecutionPermit,
      decisionId: policyDecision.decisionId,
      policyDependencyFingerprint: policyDecision.dependencyFingerprint
    })
  }
  const invariantId = SYSTEM_INVARIANT_ID_BY_GATE_RULE[decision.ruleId]
  audit.record({
    ts: Date.now(),
    event: 'policy.decision',
    lane,
    ...(lane === 'wechat' || lane === 'feishu' ? { policyDomain: 'im' as const } : { policyDomain: 'desktop' as const }),
    ...(args.policyBinding ? { policyDomain, policyBehaviorVersion: args.policyBinding.policyBehaviorVersion,
      policyRevision: args.policyBinding.revision, policyEpoch: args.policyBinding.epoch } :
      args.imPolicySnapshot ? { policyBehaviorVersion: args.imPolicySnapshot.policyBehaviorVersion, policyRevision: args.imPolicySnapshot.revision } : {}),
    factsCompleteness,
    factsSnapshotId: factsSnapshot.factId,
    extractorVersion: factsSnapshot.extractorVersion,
    factsRevision: factsSnapshot.factsRevision,
    decisionId: policyDecision.decisionId,
    policyDependencyFingerprint: policyDecision.dependencyFingerprint,
    decisionRuleIds: [...policyDecision.ruleIds],
    reviewPath: decision.type === 'require-confirm'
      ? decision.answerer === 'agent' ? 'approval-agent' : 'user-confirmation'
      : 'deterministic-policy',
    ...(decision.type === 'require-confirm' && decision.cause ? { fallbackCause: decision.cause } : {}),
    origin,
    sessionId: args.sessionId,
    requestId: args.requestId,
    toolUseId: args.toolUseId,
    toolName: args.toolName,
    ...((readPathFact?.normalizedPath || writePathFact?.normalizedPath || feishuMediaFact?.normalizedPath || wechatMediaPathFact?.normalizedPath)
      ? { factId: auditFactId(`fact-${readPathFact?.normalizedPath ?? writePathFact?.normalizedPath ?? feishuMediaFact?.normalizedPath ?? wechatMediaPathFact?.normalizedPath}`) }
      : {}),
    actionClass: facts.actionClass,
    riskLevel: facts.baseRiskLevel,
    factsSummary: args.toolName === 'run_shell' ? 'run_shell 路径及命令影响事实已检查' : facts.summary.text,
    signals: facts.signals.map((s) => s.kind),
    ...(selectedDirectoryGrant ? { directoryGrantId: selectedDirectoryGrant.grantId, directoryGrantSource: selectedDirectoryGrant.source } : {}),
    pathZones: [...new Set(facts.signals.flatMap((s) => s.kind === 'path-target' ? [s.zone] : s.kind === 'wechat-media-target' && s.zone ? [s.zone] : []))],
    decision: decision.type,
    ruleId: decision.ruleId,
    ...(invariantId ? { invariantId } : {}),
    reason: decision.type === 'require-confirm' ? decision.ruleId : decision.reason,
    ...(decision.type === 'require-confirm' ? { answerer: decision.answerer } : {}),
    ...(decision.type === 'deny' && decision.ruleId === 'recursion-guard'
      ? { cause: 'recursion-blocked' as const }
      : {}),
    ...(args.policyOrigins?.[decision.ruleId]
      ? { ruleOrigin: args.policyOrigins[decision.ruleId]!.source }
      : {}),
    ...(result.diagnostics ? { denyClass: result.diagnostics.denyClass, basis: result.diagnostics.basis } : {}),
    ...(args.factsProvider ? { factSources } : {}),
    actor: 'system'
  })

  if (decision.type === 'deny' && decision.ruleId.startsWith('remote-outbound-budget-pause-')) {
    result.budgetPause = outboundBudgetMessage ?? { message: decision.reason, reason: 'remote_task_budget' }
  }
  // H2：写文件自动批准的显式结果（快通道批准 && 决策为放行）——审计与 meta 的判定来源，
  // 不再用已删除的 desktop-auto-approve ruleId 匹配
  result.fileAutoApproved = fileAutoApprove === true && decision.type === 'auto-allow'
  result.decision = decision
  result.policyDecision = policyDecision
  result.facts = facts
  result.readPathFact = readPathFact
  result.wechatMediaPathFact = wechatMediaPathFact
  result.feishuMediaFact = feishuMediaFact
  result.writePathFact = writePathFact
  result.automationOutputBinding = automationOutputBinding
  result.automationOutputScope = automationOutputScope
  return result
}

async function buildReviewScopeCandidate(
  args: ToolCallGateArgs,
  lane: ExecutionLane,
  writePathFact: WritePathFact | undefined,
  readPathFact: import('./extractors/readPathFacts').ReadPathFact | undefined
): Promise<ReviewScopeCandidate | undefined> {
  if (!args.reviewScopeCache || args.taskDigestTruncated || args.reviewScopeEvidenceComplete !== true ||
    typeof args.reviewScopeTaskIdentity !== 'string' || !args.reviewScopeTaskIdentity ||
    Buffer.byteLength(args.reviewScopeTaskIdentity, 'utf8') > 64 * 1024 || !args.policyBinding || args.policyBinding.domain === 'automation') return undefined
  if (lane === 'desktop' && args.toolName === 'grep' && readPathFact) {
    return {
      lane, sessionId: args.sessionId, subjectId: args.userDataDir,
      authorizationDomain: { id: args.policyBinding.domain, revision: args.policyBinding.revision, epoch: args.policyBinding.epoch },
      toolName: 'grep', operation: 'search', objects: [{ role: 'root', value: readPathFact.normalizedPath }],
        environment: args.workDir, policyVersion: args.policyBinding.policyBehaviorVersion,
        exactParameters: { recursive: args.toolInput.recursive === true }, taskConstraint: args.reviewScopeTaskIdentity
    }
  }
  if (args.toolName !== 'edit_file' && args.toolName !== 'write_file') return undefined
  if (!writePathFact || writePathFact.zone !== 'workdir-normal' || !['file', 'missing'].includes(writePathFact.targetKind)) return undefined
  const subjectId = lane === 'desktop' ? args.userDataDir : args.remoteContext?.authOwner
  if (!subjectId || lane === 'automation') return undefined
  const proposedContent = args.toolName === 'write_file'
    ? typeof args.toolInput.content === 'string' ? args.toolInput.content : undefined
    : typeof args.toolInput.old_string === 'string' && typeof args.toolInput.new_string === 'string'
      ? await projectReviewScopeEditResult({ target: writePathFact, oldString: args.toolInput.old_string,
          newString: args.toolInput.new_string, replaceAll: Boolean(args.toolInput.replace_all),
          tolerateEscapeLayer: args.toolInput.tolerate_escape_layer === true })
      : undefined
  if (args.toolName === 'edit_file' && proposedContent === undefined) return undefined
  if (args.toolName === 'write_file' && proposedContent === undefined) return undefined
  if (!await isReviewScopeWriteEligible({ target: writePathFact, workDir: args.workDir, ...(proposedContent !== undefined ? { proposedContent } : {}) })) return undefined
  const toolName = args.toolName
  const operation = toolName === 'edit_file' ? 'edit' : 'write'
  const exactParameters = toolName === 'edit_file'
    ? { replaceAll: Boolean(args.toolInput.replace_all) }
    : {}
  return {
    lane: lane as ReviewScopeCandidate['lane'], sessionId: args.sessionId, subjectId,
    authorizationDomain: { id: args.policyBinding.domain, revision: args.policyBinding.revision, epoch: args.policyBinding.epoch },
    toolName, operation, objects: [{ role: 'target', value: writePathFact.normalizedPath }],
    environment: args.workDir, policyVersion: args.policyBinding.policyBehaviorVersion,
    exactParameters, taskConstraint: args.reviewScopeTaskIdentity
  }
}
