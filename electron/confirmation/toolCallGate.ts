import { decide } from '../../src/shared/policy/policyEngine'
import type { PolicyRule } from '../../src/shared/confirmation/types'
import { validatePolicyRulesFloor } from '../../src/shared/policy/policyFloor'
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
import { buildReadExecutionPermit, readInputDigest, type ReadExecutionPermit } from './readExecutionPermit'
import type { WriteExecutionPermit } from './writeExecutionPermit'
import { readConfirmationRegistry, type ReadConfirmationRegistry } from './readConfirmationRegistry'
import { validateDesktopReadV1 } from '../../src/shared/policy/readPolicyV1'
import { DEFAULT_USER_CONFIRMATION_TIMEOUT_MS } from './confirmationTimeout'
import { extractScriptSignals } from './extractors/scriptAnalysisExtractor'
import { analyzeScriptContent, parsePythonModule, type ScriptAnalysisResult } from '../shell/scriptContentSecurity'
import type { IrModule } from '../shell/scriptIr/types'
import { precheckRunShellTool } from '../shell/shellToolLoopHelpers'
import { analyzeShellCommand } from '../shell/analyzeShellCommand'
import { classifyShellCommandEffect } from './extractors/shellEffectFacts'
import { extractScriptPathFacts } from './extractors/scriptPathFacts'
import { getEffectiveSensitivePrefixes } from '../shell/shellSensitivePaths'
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
import type { ShellAnalysisResult } from '../shell/shellTypes'
import { classifyWikiPath, resolveWikiRelPath } from '../wiki/wikiPaths'
import type { ShellSecurityHints } from '../../src/shared/domainTypes'


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
  sessionId: string
  workDir: string
  userDataDir: string
  /** 显式 lane（偏差 21：由驱动源层解析后随调用传入）；缺省回退 remoteContext 推导，最终 desktop。 */
  lane?: ExecutionLane
  remoteContext?: RemoteContext
  toolsConfig: ToolsConfig
  shellConfig?: ShellConfig | null
  browserConfig?: BrowserConfig | null
  feishuConfig?: FeishuConfig
  wechatConfig?: WeChatConfig
  wikiConfig?: WikiConfig
  /** 装配期解析的生效规则集（B1：必填，缺料 fail-loud，不回退内置默认规则）。 */
  effectiveRules: PolicyRule[]
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
}

export interface ToolCallGateResult {
  decision: Decision
  facts: ContentFacts
  approvedFactIds: Array<{ factId: string; decisionRuleId: string }>
  readTargetMapping?: Array<{ factId: string; decisionRuleId: string }>
  readExecutionPermit?: ReadExecutionPermit
  readPathFact?: import('./extractors/readPathFacts').ReadPathFact
  wechatMediaPathFact?: ReadPathFact
  feishuMediaFact?: FeishuMediaTargetFact
  writePathFact?: WritePathFact
  writeExecutionPermit?: WriteExecutionPermit
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
  const channelConfig = args.remoteContext
    ? args.remoteContext.source === 'feishu'
      ? args.feishuConfig
      : args.wechatConfig
    : undefined
  const audit = args.audit ?? getSecurityAuditLog()
  const result: ToolCallGateResult = {
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

  // ===== P3 底线校验（§7.1 判据 2）：传入规则集相对 locked 底线可收紧不可放宽 =====
  // 违规 → 拒绝本次工具调用 + cause=rules-violated 审计（与正常拒绝、缺料失败互斥不混计）
  const floorCheck = validatePolicyRulesFloor(args.effectiveRules)
  if (!floorCheck.ok) {
    result.decision = {
      type: 'deny',
      ruleId: 'rules-violated',
      reason: `POLICY_RULES_FLOOR_VIOLATED(${floorCheck.violations.join(',')})`
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
        const fact = await probeWritePathFact({ rawPath: expanded, workDir: args.workDir, userDataDir: args.userDataDir, homeDir: home, customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? [] })
        if (uniquePaths.has(fact.normalizedPath)) continue
        uniquePaths.add(fact.normalizedPath)
        shellPathSignals.push({ kind: 'path-target', path: fact.normalizedPath, zone: fact.zone })
      } catch {
        shellPathProbeFailed = true
      }
    }
    if (shellAnalysis.shellSecurityHints.outsideWorkDirRisk) shellPathSignals.push({ kind: 'path-outside-heuristic', reason: 'command-may-touch-outside-workdir' })
    shellPathSignals.push({ kind: 'command-effect', effect: classifyShellCommandEffect(command, shellAnalysis) })
    if (shellPathProbeFailed) shellPathSignals.push({ kind: 'extraction-failed', reason: 'shell-path-facts-incomplete' })
    if (lane !== 'automation') {
    const precheck = await (args.runShellPrecheck ?? precheckRunShellTool)({
      command,
      workDir: args.workDir,
      userDataDir: args.userDataDir,
      shellConfig: args.shellConfig,
      shellPrecheck: args.shellPrecheck,
      analysis: shellAnalysis
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
    } else {
      shellLegacyAutoAllowEligible = false
    }
  }

  // ===== 生效规则集（§4 第 1 区 + §2.1「自动」语义）：装配期解析注入（B1，门控不持库）=====
  // 规则集由装配期按 lane+档位解析（resolveEffectivePolicyRulesWithOrigin），引擎合成规则的
  // 档位变换经 lanePackage 同源注入（desktop standard 非 locked ask→auto-evaluator）。
  const rules = args.effectiveRules
  const lanePackage = args.lanePackage ?? 'standard'

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
  let feishuMediaFact: FeishuMediaTargetFact | undefined
  let readPathProbeFailure: ReadPathProbeError | undefined
  let writePathFact: WritePathFact | undefined
  let writePathProbeFailure: WritePathProbeError | undefined
  let writePathInputFailure = false
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
    const scriptPaths = pythonLanguage
      ? preParsedIr ? extractScriptPathFacts(code, 'python', preParsedIr) : { paths: [], completeness: 'unknown' as const, dynamicAccess: true }
      : extractScriptPathFacts(code, language)
    const pythonSignals = pythonLanguage ? extractScriptSignals(code, env, preParsedIr) : undefined
    const signals: FactSignal[] = pythonLanguage
      ? pythonSignals!.signals
      : [{ kind: 'script-language-analysis' as const, language: language === 'python' ? 'unknown' as const : language, status: 'unverified' as const }]
    const summary = pythonLanguage
      ? pythonSignals!.summary
      : { text: `run_script ${language} 路径事实已提取；内容安全分析未认证` }
    signals.push({ kind: 'script-path-extraction', completeness: scriptPaths.completeness, dynamicAccess: scriptPaths.dynamicAccess })
    for (const rawPath of scriptPaths.paths) {
      try {
        const pathFact = await probeWritePathFact({ rawPath, workDir: args.workDir, userDataDir: args.userDataDir, homeDir: os.homedir(), customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? [] })
        signals.push({ kind: 'path-target', path: pathFact.normalizedPath, zone: pathFact.zone })
      } catch {
        signals.push({ kind: 'extraction-failed', reason: 'script-path-probe-failed' })
        signals.push({ kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: true })
      }
    }
    facts = {
      toolName: 'run_script',
      actionClass: 'execute',
      baseRiskLevel: 'high',
      signals,
      summary
    }
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
        writePathFact = await probeWritePathFact({
          rawPath,
          workDir: args.workDir,
          userDataDir: args.userDataDir,
          homeDir: os.homedir(),
          customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? []
        })
        let writeScope: 'inside-workdir' | 'outside-workdir' | 'unknown'
        try {
          writeScope = await classifyWriteTargetScope(writePathFact.normalizedPath, args.workDir)
        } catch {
          writeScope = 'unknown'
        }
        facts = {
          toolName: descriptor.toolName,
          actionClass: descriptor.actionClass,
          baseRiskLevel: descriptor.riskLevel,
          signals: [
            { kind: 'path-target', path: writePathFact.normalizedPath, zone: writePathFact.zone },
            { kind: 'write-target-scope', scope: writeScope }
          ],
          summary: { text: `${args.toolName} 写入目标已检查` }
        }
        if (writePathFact.targetKind !== 'file' && writePathFact.targetKind !== 'missing') facts.signals.push({ kind: 'write-target-unsupported' })
        if (args.wikiConfig?.enabled && classifyWikiPath(args.workDir, args.wikiConfig, resolveWikiRelPath(args.workDir, args.wikiConfig, rawPath)) === 'raw') {
          facts.signals.push({ kind: 'wiki-raw-target' })
        }
      } catch (error) {
        if (!(error instanceof WritePathProbeError)) throw error
        writePathProbeFailure = error
        facts = {
          toolName: descriptor.toolName,
          actionClass: descriptor.actionClass,
          baseRiskLevel: descriptor.riskLevel,
          signals: [{ kind: 'extraction-failed', reason: error.caseId }],
          summary: { text: '写入目标无法检查' }
        }
      }
    } else {
      facts = descriptor ? runExtractors(descriptor, args.toolInput, env) : {
        toolName: args.toolName, actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: args.toolName }
      }
    }
  } else {
    const descriptor = getBuiltinToolMetadata(args.toolName)
    if (descriptor) {
      if (args.toolName === 'list_directory' || args.toolName === 'grep' || (args.toolName === 'read_file' && extractPathField(args.toolInput) !== undefined)) {
        try {
          const readResult = await runExtractorsWithReadPathFact(descriptor, args.toolInput, {
            ...env,
            userDataDir: args.userDataDir,
            homeDir: os.homedir(),
            customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? []
          })
          facts = readResult.facts
          readPathFact = readResult.readPathFact
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
            wechatMediaPathFact = await probeReadPathFact({
              rawPath: mediaPath,
              workDir: args.workDir,
              userDataDir: args.userDataDir,
              homeDir: os.homedir(),
              customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes ?? []
            })
            let workdirScope: 'inside-workdir' | 'outside-workdir' | 'unknown'
            try {
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
          } catch (error) {
            if (!(error instanceof ReadPathProbeError)) throw error
            facts.signals.push({ kind: 'wechat-media-target', boundary: 'unknown', targetKind: 'unknown' })
            facts.signals.push({ kind: 'extraction-failed', reason: error.caseId })
          }
        }
      } else {
        facts = runExtractors(descriptor, args.toolInput, env)
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

  if (args.toolName === 'run_shell' && facts) facts.signals.push(...shellPathSignals)

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
  if (lane === 'desktop') {
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
  const deps: PolicyEngineDeps = {
    cache,
    config,
    migrationComplete: isRemoteSecurityMigrationComplete(channelConfig),
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
  facts.factSources = factSources
  facts.factsProviderDeclared = args.factsProvider !== undefined

  // 写路径事实必须先于桌面写快通道。快通道只能消费已探测事实，不能自行重做路径分类。
  let fileAutoApprove: boolean | undefined
  if (lane === 'desktop' && (args.toolName === 'write_file' || args.toolName === 'edit_file')) {
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
      const targetMayUseFastTrack = writePathFact?.zone === 'workdir-normal' && (writePathFact.targetKind === 'file' || writePathFact.targetKind === 'missing')
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
  const explicitReadPath = isListDirectoryTool ? (extractPathField(args.toolInput) ?? '.') : isReadTool ? extractPathField(args.toolInput) : undefined
  const readHasUnsupportedPattern = explicitReadPath !== undefined && hasUnsupportedV1ReadTarget(args.toolName, args.toolInput)
  const desktopReadValidation = lane === 'desktop' && isReadTool
    ? validateDesktopReadV1({ facts, context, zone: readPathFact?.zone, targetKind: readPathFact?.targetKind, hasExplicitPath: explicitReadPath !== undefined, hasUnsupportedPattern: readHasUnsupportedPattern })
    : undefined
  const directoryReadValidation = isListDirectoryTool
    ? !readPathFact || readPathFact.scope !== 'direct-entries-snapshot' || !(readPathFact.targetKind === 'directory' || (readPathFact.targetKind === 'symlink' && readPathFact.resolvedKind === 'directory'))
      ? { type: 'deny' as const, ruleId: 'directory-read-target-unsupported', reason: '目录读取仅支持存在的目录目标' }
      : undefined
    : undefined
  const fileReadValidation = (args.toolName === 'read_file' || args.toolName === 'grep') && readPathFact &&
    !(['file', 'missing'].includes(readPathFact.targetKind) || (readPathFact.targetKind === 'symlink' && readPathFact.resolvedKind === 'file'))
    ? { type: 'deny' as const, ruleId: 'read-v1-target-unsupported', reason: 'V1 文件读取仅支持单个普通文件目标' }
    : undefined
  let decision = writePathInputFailure
    ? { type: 'deny' as const, ruleId: 'write-path-input-invalid', reason: '缺少有效的路径参数，已阻止写入' }
    : writePathProbeFailure
    ? { type: 'deny' as const, ruleId: writePathProbeFailure.caseId, reason: '写入目标事实探测失败，已阻止执行' }
    : readPathProbeFailure
    ? { type: 'deny' as const, ruleId: readPathProbeFailure.caseId, reason: '读取目标事实探测失败，已阻止执行' }
    : directoryReadValidation
    ? directoryReadValidation
    : fileReadValidation
    ? fileReadValidation
    : desktopReadValidation
    ? desktopReadValidation
    : lane === 'automation' && isReadTool && (!readPathFact || readPathFact.targetKind === 'directory' || readHasUnsupportedPattern)
      ? { type: 'deny' as const, ruleId: 'automation-read-target-unsupported', reason: 'automation lane 仅支持显式、单目标文件读取' }
      : decide(facts, context, rules, deps)

  // 目录外只读是安全边界例外，只能细化已放行的结果，不能覆盖套餐或自定义规则要求的确认。
  // 保留其原规则结论也让后续审批会话递归守卫继续看到 require-confirm。
  if (shellOutsideReadOnly && decision.type === 'auto-allow') {
    decision = { type: 'auto-allow', ruleId: 'shell-outside-readonly-allow', reason: '工作目录外的只读 shell 命令免确认' }
  }

  // 写路径离开 workdir 时，不能继承泛化策略/缓存的自动放行；走既有人工确认路径。
  if (writePathFact && writePathFact.zone !== 'workdir-normal' && decision.type === 'auto-allow') {
    decision = lane === 'automation'
      ? { type: 'deny', ruleId: 'automation-outside-write-deny', reason: 'automation lane 不允许工作目录外写入' }
      : { type: 'require-confirm', ruleId: 'write-outside-confirm', answerer: lane === 'desktop' ? 'agent' : 'user', riskLevel: facts.baseRiskLevel, facts, memoryTiers: [], timeoutMs: null }
  }

  // ===== P2-4 递归守卫（I5）：审批会话内的 require-confirm 一律 fail-closed =====
  // 守卫在回答者解析之前生效，否则内层 require-confirm 会被再次解析到 AgentChannel 造成递归。
  // 不可进规则集：进规则集就会被 custom/loose 改坏，收紧致自动审批静默停摆（不可变集，非 locked 底线集）。
  if (decision.type === 'require-confirm' && args.internalConfirmExemption === 'approval-agent') {
    const reason = '安全策略无法完成裁决：审批会话内不允许再进入确认流程（递归守卫）'
    decision = { type: 'deny', ruleId: 'recursion-guard', reason }
  }

  if (readPathFact && isPermitReadTool && (decision.type === 'auto-allow' || (decision.type === 'require-confirm' && decision.answerer === 'user')) && (readPathFact.targetKind !== 'directory' || isListDirectoryTool)) {
    const readTarget = { factId: `fact-${readPathFact.normalizedPath}`, decisionRuleId: decision.ruleId }
    result.readTargetMapping = [readTarget]
    if (decision.type === 'auto-allow') result.approvedFactIds = [readTarget]
  }

  if (readPathFact && isPermitReadTool && decision.type === 'auto-allow' && (readPathFact.targetKind !== 'directory' || isListDirectoryTool)) {
    result.readExecutionPermit = buildReadExecutionPermit({
      requestId: args.requestId ?? args.sessionId,
      toolUseId: args.toolUseId ?? args.toolName,
      toolName: args.toolName as 'read_file' | 'grep' | 'list_directory',
      decisionRuleId: decision.ruleId,
      input: args.toolInput,
      facts: [{ factId: `fact-${readPathFact.normalizedPath}`, decisionRuleId: decision.ruleId, normalizedPath: readPathFact.normalizedPath, zone: readPathFact.zone, targetKind: isListDirectoryTool && (readPathFact.targetKind === 'directory' || readPathFact.resolvedKind === 'directory') ? 'directory' : readPathFact.targetKind, ...(isListDirectoryTool ? { scope: 'direct-entries' as const } : {}), ...(readPathFact.resolvedKind ? { resolvedKind: readPathFact.resolvedKind } : {}), ...(readPathFact.identity ? { identity: readPathFact.identity } : {}) }]
    })
  } else if (readPathFact && decision.type === 'require-confirm' && decision.answerer === 'user' && (readPathFact.targetKind !== 'directory' || isListDirectoryTool)) {
    const registry = args.readConfirmationRegistry ?? readConfirmationRegistry
    const registered = registry.register({
      requestId: args.requestId ?? args.sessionId,
      toolUseId: args.toolUseId ?? args.toolName,
      inputDigest: readInputDigest(args.toolInput),
      factIds: [`fact-${readPathFact.normalizedPath}`],
      ruleId: decision.ruleId,
      expiresAt: Date.now() + (decision.timeoutMs ?? DEFAULT_USER_CONFIRMATION_TIMEOUT_MS)
    })
    if (!registered) decision = { type: 'deny', ruleId: 'read-confirmation-registration-failed', reason: '无法建立本次读取确认登记，已阻止执行' }
  }

  if (feishuMediaFact?.boundary === 'inside' && feishuMediaFact.targetKind === 'file' && feishuMediaFact.normalizedPath && feishuMediaFact.identity && (decision.type === 'auto-allow' || (decision.type === 'require-confirm' && decision.answerer === 'user'))) {
    const factId = `fact-${feishuMediaFact.normalizedPath}`
    const readTarget = { factId, decisionRuleId: decision.ruleId }
    result.readTargetMapping = [readTarget]
    if (decision.type === 'auto-allow') result.approvedFactIds = [readTarget]
    else {
      const registry = args.readConfirmationRegistry ?? readConfirmationRegistry
      const registered = registry.register({
        requestId: args.requestId ?? args.sessionId,
        toolUseId: args.toolUseId ?? args.toolName,
        inputDigest: readInputDigest(args.toolInput),
        factIds: [factId],
        ruleId: decision.ruleId,
        expiresAt: Date.now() + (decision.timeoutMs ?? DEFAULT_USER_CONFIRMATION_TIMEOUT_MS)
      })
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
  audit.record({
    ts: Date.now(),
    event: 'policy.decision',
    lane,
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
    pathZones: [...new Set(facts.signals.flatMap((s) => s.kind === 'path-target' ? [s.zone] : s.kind === 'wechat-media-target' && s.zone ? [s.zone] : []))],
    decision: decision.type,
    ruleId: decision.ruleId,
    reason: decision.type === 'require-confirm' ? decision.ruleId : decision.reason,
    ...(decision.type === 'require-confirm' ? { answerer: decision.answerer } : {}),
    ...(decision.type === 'deny' && decision.ruleId === 'recursion-guard'
      ? { cause: 'recursion-blocked' as const }
      : {}),
    ...(args.policyOrigins?.[decision.ruleId]
      ? { ruleOrigin: args.policyOrigins[decision.ruleId]!.source }
      : {}),
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
  result.facts = facts
  result.readPathFact = readPathFact
  result.wechatMediaPathFact = wechatMediaPathFact
  result.feishuMediaFact = feishuMediaFact
  result.writePathFact = writePathFact
  return result
}
