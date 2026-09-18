import type {
  AgentEventSink,
  AgentHostPorts,
  AgentInvocation,
  AgentNotifyEvent
} from '../../src/shared/agent/invocation'
import { AGENT_ADDITIONAL_CONTEXT_KEYS } from '../../src/shared/agent/invocation'
import type { FloatingNotificationManager } from '../floatingNotificationManager'
import { resolveEffectivePolicyRulesWithOrigin } from '../confirmation/policyRulesRuntime'
import { intersectPolicyRulesWithFloor } from '../../src/shared/policy/policyFloor'
import { SqliteDecisionCache } from '../confirmation/sqliteDecisionCache'
import { touchTrustedCommand } from '../shell/shellCommandTrust'
import { getDbConnection, getSession, updateSession } from '../database'
import { readStoredModels } from '../llmServiceResolver'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { AppDatabase } from '../database'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { recordStepUsage, recordTurnSummary } from '../usageStats/usageStatsRecorder'
import { safeAppendDiagnostic } from '../mcp/mcpDiagnostics'
import { scheduleSessionTitleSuggestion } from '../sessionTitleSuggest'
import { recordUserAnswerFromDecision } from '../confirmation/decisionCacheWriter'
import { resolveLaneAnswererPolicy } from '../confirmation/answererConfig'
import { buildSnapshotFromDb, type McpToolSnapshot } from '../mcp/mcpToolRegistry'
import { resolveRequestLocale } from '../llmSystemPrompt'
import { listProfiles } from '../mcp/mcpConfigStore'
import { getSecret } from '../mcp/mcpSecretStore'
import { getDiagnostics } from '../mcp/mcpDiagnostics'
import { createMcpOAuthClientProvider } from '../mcp/mcpOauthService'
import { createMcpToolExecutor } from '../mcp/mcpToolExecutor'
import { getSecurityAuditLog } from '../confirmation/audit'
import type { McpConnectionManager } from '../mcp/mcpConnectionManager'

/**
 * Runtime 唯一装配点（roadmap「Runtime 是唯一装配点」在主进程的落位）。
 *
 * P1 立骨架：把调用方材料（字段名平移自原 RunToolChatSessionArgs）映射为
 * AgentInvocation + AgentHostPorts；P2 起在此承接端口实现（storage / usage / tools、
 * 规则与预检材料解析），P4 承接 Profile 解析，P6 承接 sink 注册。
 */

/** 调用方装配材料：字段与原 RunToolChatSessionArgs 同构（floatingNotificationManager 由装配器消化为 events.notify）。 */
export interface AgentInvocationMaterials {
  requestId: string
  sessionId: string
  turnId?: string
  llmServiceId?: string
  windowId?: string
  model: string
  contextWindow?: number
  baseUrl?: string
  messages: readonly unknown[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  /** P4（偏差 6）：显式思维强度档位；优先于 enableThinking 兼容映射；缺省 'off'（零成本档）。 */
  effort?: import('../../src/shared/agent/invocation').AgentReasoningEffort
  toolsConfig: import('../../src/shared/domainTypes').ToolsConfig
  browserConfig?: import('../../src/shared/domainTypes').BrowserConfig
  shellConfig?: import('../../src/shared/domainTypes').ShellConfig | null
  wikiConfig?: import('../../src/shared/domainTypes').WikiConfig
  feishuConfig?: import('../../src/shared/domainTypes').FeishuConfig
  wechatConfig?: import('../../src/shared/domainTypes').WeChatConfig
  larkCliRunner?: import('../feishu/larkCliRunner').LarkCliRunner
  lane?: import('../../src/shared/confirmation/types').ExecutionLane
  internalConfirmExemption?: 'approval-agent'
  maxToolLoopRounds?: number
  approvalTaskDigest?: string
  remoteContext?: import('../tools/types').RemoteContext
  workDir: string
  workDirManager?: import('../workDirManager').WorkDirManager
  resolveWorkDir?: () => string
  userDataDir: string
  getApiKey: () => Promise<string | null>
  appDb?: unknown
  locale?: import('../../src/shared/domainTypes').AppLocale
  projectMemoryEnabled?: boolean
  skillFragments?: string[]
  currentUserMessageId?: string
  historyFacts?: readonly unknown[]
  assistantMessageId?: string
  hasImageAttachments?: boolean
  getBrowserDetectContext?: () => import('../../src/shared/browserTypes').BrowserDetectContext
  /** P3：父调用的规则集上界（嵌套调用取交集；放行集合只收窄，授权不继承）。 */
  policyRuleFloor?: import('../../src/shared/confirmation/types').PolicyRule[]
  /** §5.5 收口：宿主实例在此包装为 events.notify，不再进入调用契约。 */
  floatingNotificationManager?: FloatingNotificationManager
  emitFactEvent: (event: import('../../src/shared/assistantFactAggregator').AssistantFactEvent) => void
  emitSessionEvent: (event: import('../sessionEvents').SessionEventInput) => void | Promise<void>
  onFileTreeChanged?: (event: import('../../src/shared/fileTreeSync').FileTreeChangeEvent) => void
  onTitleGenerated?: (session: import('../../src/shared/domainTypes').Session) => void
  appendCompactionTransaction?: (start: Record<string, unknown>, summary: Record<string, unknown>) => Promise<unknown>
  contextMeter?: import('../toolChatLoop').RunToolChatSessionArgs['contextMeter']
  onTurnBoundary?: import('../toolChatLoop').RunToolChatSessionArgs['onTurnBoundary']
}

/** 把宿主 FloatingNotificationManager 包装为 events.notify 出口实现（§5.5 收口）。 */
function wrapNotify(manager: FloatingNotificationManager): (event: AgentNotifyEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'confirm-request':
        manager.onConfirmRequest({
          requestId: event.requestId,
          sessionId: event.sessionId,
          sessionName: event.sessionName,
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          createdAt: Date.now()
        })
        break
      case 'tool-result':
        manager.onToolResult(event.requestId, event.toolUseId)
        break
      case 'request-all-cancelled':
        manager.onAllCancelledForRequest(event.requestId)
        break
    }
  }
}

/** 材料中可空的可选事件出口归一为对象。 */
function buildEventSink(materials: AgentInvocationMaterials): AgentEventSink {
  return {
    onFact: materials.emitFactEvent,
    onSessionEvent: materials.emitSessionEvent as AgentEventSink['onSessionEvent'],
    ...(materials.onFileTreeChanged ? { onFileTreeChanged: (event) => materials.onFileTreeChanged?.(event) } : {}),
    ...(materials.onTitleGenerated ? { onTitleGenerated: (session) => materials.onTitleGenerated?.(session) } : {}),
    ...(materials.floatingNotificationManager ? { notify: wrapNotify(materials.floatingNotificationManager) } : {})
  }
}

export function assembleInvocation(materials: AgentInvocationMaterials): {
  invocation: AgentInvocation
  ports: AgentHostPorts
} {
  const db = materials.appDb as AppDatabase | undefined
  const additionalContext: Record<string, unknown> = {}
  if (materials.approvalTaskDigest !== undefined) {
    additionalContext[AGENT_ADDITIONAL_CONTEXT_KEYS.approvalTaskDigest] = materials.approvalTaskDigest
  }
  if (materials.historyFacts !== undefined) {
    additionalContext[AGENT_ADDITIONAL_CONTEXT_KEYS.historyFacts] = materials.historyFacts
  }

  // locale 定值（请求优先、库回退在装配期完成；循环内不再查库）
  const resolvedLocale = resolveRequestLocale(materials.locale, db as never)

  // P4（偏差 6）：effort 解析——显式档位 > enableThinking 兼容映射（true→medium）> off（子调用零成本档）；
  // 宿主按 ModelEntry 能力校验，不支持时按定死规则降级为 off 并留痕（不静默换档）
  const requestedEffort = materials.effort
    ?? (materials.options?.enableThinking === true ? 'medium' : 'off')
  let reasoningEffort = requestedEffort
  let reasoningDegraded: import('../../src/shared/agent/invocation').AgentReasoningProfile['degraded']
  if (db && reasoningEffort !== 'off') {
    const entry = readStoredModels(db).find((m) => m.name === materials.model)
    if (entry?.supportsThinking === false) {
      reasoningDegraded = { from: requestedEffort, to: 'off' }
      reasoningEffort = 'off'
      logAgentEvent('info', 'agent.profile.reasoning_degraded', {
        requestId: materials.requestId,
        sessionId: materials.sessionId,
        model: materials.model,
        from: requestedEffort,
        to: 'off',
        reason: 'model-not-support-thinking'
      })
    }
  }
  const reasoning = { effort: reasoningEffort, ...(reasoningDegraded ? { degraded: reasoningDegraded } : {}) }

  const invocation: AgentInvocation = {
    session: { sessionId: materials.sessionId },
    messages: {
      list: materials.messages as AgentInvocation['messages']['list'],
      ...(materials.currentUserMessageId !== undefined ? { currentUserMessageId: materials.currentUserMessageId } : {}),
      ...(materials.assistantMessageId !== undefined ? { assistantMessageId: materials.assistantMessageId } : {}),
      ...(materials.hasImageAttachments !== undefined ? { hasImageAttachments: materials.hasImageAttachments } : {})
    },
    profile: {
      model: materials.model,
      ...(materials.llmServiceId !== undefined ? { llmServiceId: materials.llmServiceId } : {}),
      ...(materials.contextWindow !== undefined ? { contextWindow: materials.contextWindow } : {}),
      ...(materials.system !== undefined ? { system: materials.system } : {}),
      ...(materials.options !== undefined ? { options: materials.options } : {}),
      ...(resolvedLocale !== undefined ? { locale: resolvedLocale } : {}),
      ...(materials.projectMemoryEnabled !== undefined ? { projectMemoryEnabled: materials.projectMemoryEnabled } : {}),
      ...(materials.skillFragments !== undefined ? { skillFragments: materials.skillFragments } : {}),
      tools: {
        toolsConfig: materials.toolsConfig,
        ...(materials.browserConfig !== undefined ? { browserConfig: materials.browserConfig } : {}),
        ...(materials.shellConfig !== undefined ? { shellConfig: materials.shellConfig } : {}),
        ...(materials.wikiConfig !== undefined ? { wikiConfig: materials.wikiConfig } : {}),
        ...(materials.feishuConfig !== undefined ? { feishuConfig: materials.feishuConfig } : {}),
        ...(materials.wechatConfig !== undefined ? { wechatConfig: materials.wechatConfig } : {}),
        ...(materials.larkCliRunner !== undefined ? { larkCliRunner: materials.larkCliRunner } : {})
      },
      ...(materials.lane !== undefined ? { lane: materials.lane } : {}),
      reasoning
    },
    events: buildEventSink(materials),
    limits: {
      ...(materials.maxToolLoopRounds !== undefined ? { maxToolRounds: materials.maxToolLoopRounds } : {})
    },
    safety: {
      ...(materials.internalConfirmExemption !== undefined ? { recursionGuard: materials.internalConfirmExemption } : {})
    },
    additionalContext,
    trace: {
      requestId: materials.requestId,
      ...(materials.turnId !== undefined ? { turnId: materials.turnId } : {}),
      ...(materials.windowId !== undefined ? { windowId: materials.windowId } : {})
    },
    ...(materials.remoteContext !== undefined ? { driverContext: materials.remoteContext } : {})
  }

  // ===== P2（B1）：门控端口材料装配期解析 =====
  // lane 推导与 Core 外壳同一规则（显式 lane → remoteContext 推导 → desktop）
  const materialsLane = materials.lane
    ?? (materials.remoteContext
      ? materials.remoteContext.source === 'feishu'
        ? 'feishu'
        : 'wechat'
      : 'desktop')
  // P3：带来源解析 + 嵌套交集（floor 上界由调用方声明；放行集合只收窄）
  const withOrigin = db
    ? resolveEffectivePolicyRulesWithOrigin(db, materialsLane)
    : { rules: DEFAULT_POLICY_RULES as import('../../src/shared/confirmation/types').PolicyRule[], origins: {} }
  const effectiveRules = materials.policyRuleFloor
    ? intersectPolicyRulesWithFloor(withOrigin.rules, materials.policyRuleFloor)
    : withOrigin.rules
  const policy = db
    ? {
        effectiveRules,
        decisionCache: new SqliteDecisionCache(getDbConnection(db)),
        shellPrecheck: { touchTrustedCommand: (command: string) => touchTrustedCommand(db, command) },
        origins: withOrigin.origins
      }
    : {
        // 无库宿主（内存端口 / 测试）：显式默认材料 + 留痕——不是门控侧静默回退
        effectiveRules: DEFAULT_POLICY_RULES,
        decisionCache: { lookup: () => null },
        shellPrecheck: { touchTrustedCommand: () => undefined }
      }
  if (!db) {
    logAgentEvent('info', 'agent.policy.default_materials', {
      requestId: materials.requestId,
      lane: materialsLane,
      reason: 'no-database-host'
    })
  }

  // ===== P2 批次 B：Core 脱库的装配期材料 =====
  // 真相类端口失败可观测（§2.4 标准 3）：落审计诊断 + 原样 rethrow——
  // 执行结论仍为调用显式失败（fail-cancelled 语义随异常传播保持），但不再静默。
  const persistObservable = <T>(op: string, fn: () => T): T => {
    try {
      return fn()
    } catch (e) {
      logAgentEvent('error', 'agent.persist.failed', {
        requestId: materials.requestId,
        sessionId: materials.sessionId,
        op,
        error: e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  }
  const storage = {
    ...(db
      ? {
          loaded: { metadata: getSession(db, materials.sessionId)?.metadata },
          readSession: (sessionId: string) => getSession(db, sessionId),
          persist: {
            updateSessionMetadata: (sessionId: string, patch: Record<string, unknown>) =>
              persistObservable('updateSessionMetadata', () => updateSession(db, sessionId, patch as never)),
            scheduleTitleSuggestion: (input: Record<string, unknown>) =>
              persistObservable('scheduleTitleSuggestion', () => scheduleSessionTitleSuggestion({ ...input, db } as never)),
            recordUserAnswerFromDecision: (input: Record<string, unknown>) =>
              persistObservable('recordUserAnswerFromDecision', () => recordUserAnswerFromDecision({ ...input, db, audit: getSecurityAuditLog() } as never))
          }
        }
      : {}),
    ...(materials.appendCompactionTransaction !== undefined
      ? { appendCompactionTransaction: (start: Record<string, unknown>, summary: Record<string, unknown>) => materials.appendCompactionTransaction!(start, summary) }
      : {})
  }
  // 暴露面规则与门控同源同判（P3：带来源解析；嵌套交集同样适用）
  const exposure = db ? { rules: effectiveRules } : undefined
  const mcpSnapshot: McpToolSnapshot = db
    ? buildSnapshotFromDb(db, { remoteContext: materialsLane !== 'desktop' })
    : { entries: new Map(), budgetDropped: [] }
  const mcp = db
    ? {
        snapshot: mcpSnapshot,
        resolveExecutor: (toolName: string, manager: McpConnectionManager) => {
          const entry = mcpSnapshot.entries.get(toolName)
          if (!entry) return undefined
          const profile = listProfiles(db).find((p) => p.id === entry.serverId)
          if (!profile) return undefined
          const oauthProvider =
            profile.auth.mode === 'oauth' ? createMcpOAuthClientProvider(db, profile) : undefined
          return createMcpToolExecutor(entry, {
            getSession: (serverId: string) =>
              manager.connect(profile, async (kind) => getSecret(db, serverId, kind), { oauthProvider }),
            getProfile: () => profile,
            invalidateSession: (serverId: string) => manager.disconnect(serverId),
            getRecentDiagnostics: (serverId: string) => getDiagnostics(db, serverId)
          })
        },
        executorDatabase: db
      }
    : { snapshot: mcpSnapshot }
  const usage = db
    ? {
        recordStepUsage: (input: Record<string, unknown>) => recordStepUsage(db, input as never),
        recordTurnSummary: (input: Record<string, unknown>) => recordTurnSummary(db, input as never)
      }
    : undefined
  const diagnostics = db
    ? { append: (serverId: string, entry: unknown) => safeAppendDiagnostic(db, serverId, entry as never) }
    : undefined
  const answerer = {
    policy: resolveLaneAnswererPolicy(db, materialsLane),
    ...(db ? { approvalDatabase: db } : {})
  }

  const ports: AgentHostPorts = {
    policy,
    storage,
    exposure,
    mcp,
    usage,
    diagnostics,
    answerer,
    workspace: {
      workDir: materials.workDir,
      ...(materials.workDirManager !== undefined ? { workDirManager: materials.workDirManager } : {}),
      ...(materials.resolveWorkDir !== undefined ? { resolveWorkDir: materials.resolveWorkDir } : {}),
      userDataDir: materials.userDataDir
    },
    credentials: {
      resolveApiKey: () => materials.getApiKey(),
      ...(materials.baseUrl !== undefined ? { networkTarget: { baseUrl: materials.baseUrl } } : {})
    },
    ...(materials.appDb !== undefined ? { legacy: { appDb: materials.appDb } } : {}),
    ...(materials.getBrowserDetectContext !== undefined
      ? { hostFacts: { getBrowserDetectContext: () => materials.getBrowserDetectContext!() } }
      : {}),
    ...(materials.contextMeter !== undefined ? { contextMeter: materials.contextMeter } : {}),
    ...(materials.onTurnBoundary !== undefined ? { turnBoundary: (input) => materials.onTurnBoundary!(input as never) } : {})
  }

  return { invocation, ports }
}
