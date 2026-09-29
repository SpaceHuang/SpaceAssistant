import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase, type AppDatabase } from './database'
import { evaluateToolCallGate, type ToolCallGateArgs } from './confirmation/toolCallGate'
import { loadEffectivePolicyRules, readPolicyPackages, touchTrustedCommand } from './confirmation/policyRulesRuntime'
import { SqliteDecisionCache } from './confirmation/sqliteDecisionCache'
import { getDbConnection } from './database'
import { DEFAULT_POLICY_RULES } from '../src/shared/policy/defaultRules'
import { decide } from '../src/shared/policy/policyEngine'
import { notExecutedReasonForConfirmation } from './toolChatLoop'
import { parseApprovalVerdict } from './confirmation/approvalAgent'
import { shouldFallbackToUser, isFallbackEligibleCause } from './confirmation/fallbackToUser'
import type { ShellAnalysisResult } from './shell/shellTypes'
import type { SecurityAuditEvent, ShellSecurityHints } from '../src/shared/confirmation/types'
import type { LegacyShellPolicyInput } from './shell/legacyShellPolicyAdapter'
import { resetRunningRemoteAgentRegistryForTests } from './remote/remoteAgentRegistry'

const dbs: AppDatabase[] = []
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close())
  resetRunningRemoteAgentRegistryForTests()
})

function openDb(): AppDatabase {
  const db = openSqliteDatabase(':memory:')
  dbs.push(db)
  return db
}

function auditSink(): { record: (e: SecurityAuditEvent) => void; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { record: (e) => events.push(e), events }
}

function gateMaterials(db: AppDatabase | undefined, lane: ToolCallGateArgs['lane']) {
  if (db) {
    return {
      effectiveRules: loadEffectivePolicyRules(db, lane ?? 'desktop'),
      lanePackage: readPolicyPackages(db)[lane ?? 'desktop'] ?? 'standard',
      decisionCache: new SqliteDecisionCache(getDbConnection(db)),
      shellPrecheck: { touchTrustedCommand: (command: string) => touchTrustedCommand(db, command) }
    }
  }
  return {
    effectiveRules: DEFAULT_POLICY_RULES,
    lanePackage: 'standard',
    decisionCache: {
      lookup: () => null,
      record: () => undefined,
      clear: () => 0,
      clearAllSession: () => 0,
      expireDormant: () => 0
    },
    shellPrecheck: { touchTrustedCommand: () => undefined }
  }
}

function unsupportedAnalysis(reason: 'structure' | 'too-many-segments' = 'structure'): ShellAnalysisResult {
  return {
    verdict: 'unsupported',
    unsupportedReason: reason,
    unsupportedStructures: ['conditional-block'],
    denyReason: '命令语法解析失败，无法进行安全分析',
    segments: [],
    pathVerdict: {
      decision: 'ask',
      violations: [{ code: 'PARSE_ERROR', message: '解析失败', severity: 'warning' }],
      warnings: ['解析失败'],
      outsideWorkDirRisk: true,
      requiresRiskAck: true
    },
    shellSecurityHints: {
      requiresRiskAck: true,
      outsideWorkDirRisk: true,
      warnings: ['解析失败']
    } as ShellSecurityHints
  }
}

const legacyPolicy: LegacyShellPolicyInput = { permissionDecision: 'ask', trustedCacheKeys: [] }

function unsupportedPrecheck(analysis = unsupportedAnalysis()) {
  return async () => ({
    ok: true as const,
    analysis,
    legacyAutoAllowEligible: false,
    legacyPolicy,
    hints: analysis.shellSecurityHints
  })
}

function base(overrides: Partial<ToolCallGateArgs> & { lane?: NonNullable<ToolCallGateArgs['lane']> } = {}): ToolCallGateArgs {
  const lane = overrides.lane
  return {
    toolName: 'run_shell',
    toolInput: { command: 'cat foo | xargs bar' },
    sessionId: 's-r5',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig: { ...({} as ToolCallGateArgs['toolsConfig']), deniedTools: [] },
    audit: { record: () => undefined },
    ...gateMaterials(undefined, lane),
    ...overrides
  }
}

describe('R5：解析失败降级为确认（shell 侧）', () => {
  it('T-R5-1 前置：unsupported 命令不再产出 shellPrecheckDeny，而是携带 shell-unsupported-structure 信号进入引擎', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(base({
      audit,
      lane: 'desktop',
      runShellPrecheck: unsupportedPrecheck()
    }))
    expect(r.shellPrecheckDeny).toBeUndefined()
    expect(r.facts.signals.some((s) => s.kind === 'shell-unsupported-structure')).toBe(true)
    // desktop：引擎零特例——shell-precheck-auto-allow 未放行 → 未裁决交审批 Agent（answerer=agent）
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') {
      expect(r.decision.answerer).toBe('agent')
    }
  })

  it('T-R5-3 回归：危险命令仍 deny（R5 不放宽既有规则）', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(base({
      audit,
      lane: 'desktop',
      toolInput: { command: 'sudo apt update' }
    }))
    expect(r.decision.type).toBe('deny')
    expect(r.shellPrecheckDeny).toBeDefined()
  })

  it('T-R5-2 锚定（O9）：automation lane + unsupported → 由 lane 限定 locked deny 规则拒绝', () => {
    const decision = decide(
      {
        toolName: 'run_shell',
        actionClass: 'execute',
        baseRiskLevel: 'high',
        signals: [{ kind: 'shell-unsupported-structure', structures: ['conditional-block'], reason: 'structure' }],
        summary: { text: 'run_shell' }
      },
      { lane: 'automation', origin: { kind: 'direct-owner' }, sessionId: 's' },
      DEFAULT_POLICY_RULES,
      { cache: { lookup: () => null, record: () => undefined }, config: {}, migrationComplete: true }
    )
    expect(decision.type).toBe('deny')
    // 合并后 main 的 automation-shell-deny（automation + run_shell 全量 locked deny）先手命中——
    // 与本规则同向（无人链路 fail-closed，O9）。分支规则保留为纵深（若前者被删仍兜底）。
    expect(['automation-shell-deny', 'automation-unsupported-deny']).toContain(decision.ruleId)
  })

  it('B1 端到端：desktop + unsupported（persistable=true 形态）→ memoryTiers 无持久档，缓存不得命中放行', async () => {
    const audit = auditSink()
    const analysis = unsupportedAnalysis()
    // 树解析失败但简单解析器 persistable=true 的真实形态（评审实测：Get-ChildItem ../ 等）
    ;(analysis as { unsupportedStructures?: string[] }).unsupportedStructures = []
    const r = await evaluateToolCallGate(base({
      audit,
      lane: 'desktop',
      // N1 红绿验证的教训：命令必须是「树解析失败但 persistable=true」的真实形态
      // （评审 v2 实测 `echo )`——圆括号不在 metasyntax 正则内，简单解析器 tokenize 成功）。
      // 若用含管道的命令，facts 的 command-sequence.persistable=false 会走既有
      // non-persistable-command 排除，触达不了 B1 新增的 shell-analysis-incomplete 排除路径。
      toolInput: { command: 'echo )' },
      runShellPrecheck: unsupportedPrecheck(analysis),
      // 缓存中存在同命令的 90 天 allow 条目（用户此前确认过并勾选记住）
      // N1（评审 v2）：缓存条目形态必须是 DecisionCacheEntry 的真实形态——
      // decision 取值是 'allow' | 'deny'（policyEngine.lookupCache 只认 'allow'）；
      // mock 成其他值在任何版本下都不命中，回退 B1 修复本测试也不会红。
      decisionCache: {
        lookup: () => ({ decision: 'allow' as const, ruleId: 'cache-hit', reason: 'user-approved', expiresAt: Date.now() + 86_400_000 }),
        record: () => undefined,
        clear: () => 0,
        clearAllSession: () => 0,
        expireDormant: () => 0
      }
    }))
    // 修复前：投毒缓存命中直接 auto-allow（「partial 永不自动放行」被绕过）
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') {
      // MemoryTier 是 {key,label} 对象数组；unsupported 时记忆资格为 none → 必须为空数组
      expect(r.decision.memoryTiers).toEqual([])
    }
  })

  it('T-R5-2 gate 端到端：automation + unsupported → deny（规则在 catch-all 之前命中，不派生审批回答者）', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(base({
      audit,
      lane: 'automation',
      runShellPrecheck: unsupportedPrecheck()
    }))
    expect(r.decision.type).toBe('deny')
    if (r.decision.type === 'deny') {
      // deny 在回答者派生前结算：不可能出现 require-confirm(agent)
      expect(['automation-shell-deny', 'automation-unsupported-deny']).toContain(r.decision.ruleId)
    }
    expect(r.diagnostics?.denyClass).toBe('forbidden')
    // 审计只有 policy.decision（deny），没有 agent 侧 confirm.request
    expect(audit.events.some((e) => e.event === 'confirm.request')).toBe(false)
  })
})

describe('R5：审批侧「判定不了」态', () => {
  it('parseApprovalVerdict 解析 undetermined（取原样，不参与阈值矩阵）', () => {
    const v = parseApprovalVerdict('{"kind":"undetermined","reason":{"summary":"缺少命令目标路径，无法评估影响面"}}')
    expect(v).toMatchObject({ kind: 'undetermined', reason: { summary: '缺少命令目标路径，无法评估影响面' } })
    expect((v as { riskLevel?: unknown }).riskLevel).toBeUndefined()
  })

  it('undetermined 缺 summary 时按既有非对称容错兜底', () => {
    const v = parseApprovalVerdict('{"kind":"undetermined"}')
    expect(v?.kind).toBe('undetermined')
  })

  it('T-R5-9：notExecutedReasonForConfirmation cause=agent-undetermined → agent_undetermined（不落 user_rejected）', () => {
    expect(notExecutedReasonForConfirmation({ cause: 'agent-undetermined' })).toBe('agent_undetermined')
    expect(notExecutedReasonForConfirmation({ cause: 'agent-deny' })).toBe('agent_denied')
  })

  it('fallback 白名单：agent-undetermined 可回退；agent-deny 永不回退（T-R5-7）', () => {
    expect(isFallbackEligibleCause('agent-undetermined')).toBe(true)
    expect(isFallbackEligibleCause('agent-deny')).toBe(false)
    const outcome = {
      kind: 'rejected' as const,
      answererKind: 'agent' as const,
      cause: 'agent-undetermined' as const,
      reason: { summary: '判不了' }
    }
    expect(shouldFallbackToUser({ lane: 'desktop', channelOutcome: outcome, chatAborted: false, sharedApprovalRecoveryFailed: false })).toBe(true)
    expect(
      shouldFallbackToUser({
        lane: 'desktop',
        channelOutcome: { ...outcome, cause: 'agent-deny' } as typeof outcome,
        chatAborted: false,
        sharedApprovalRecoveryFailed: false
      })
    ).toBe(false)
  })
})

describe('B2：段数超限（too-many-segments）保留 precheck 结构化短路', () => {
  it('unsupported + too-many-segments → precheck ok:false（gate 不进 extractor，循环不中断）', async () => {
    const { precheckRunShellTool } = await import('./shell/shellToolLoopHelpers')
    const analysis = unsupportedAnalysis('too-many-segments')
    ;(analysis as { unsupportedStructures?: string[] }).unsupportedStructures = []
    const precheck = await precheckRunShellTool({
      command: Array.from({ length: 52 }, (_, i) => `echo ${i}`).join(' && '),
      workDir: 'C:\\wd',
      userDataDir: 'C:\\ud',
      shellConfig: null,
      shellPrecheck: { touchTrustedCommand: () => undefined }
    })
    // 修复前：unsupported 不短路 → gate 走 runExtractors 裸调 parseShellSegments 抛错炸整轮循环
    // 修复后：too-many-segments 保留结构化短路（方向 fail-closed，但错误形态可读、不丢同批工具）
    expect(precheck.ok).toBe(false)
    if (!precheck.ok) {
      expect(precheck.auditReason).toContain('段数')
    }
  })

  it('structure 类 unsupported（非段数超限）仍不短路——走 gate 进引擎（方案 B 语义保持）', async () => {
    const r = await evaluateToolCallGate(base({
      lane: 'desktop',
      runShellPrecheck: unsupportedPrecheck(unsupportedAnalysis('structure'))
    }))
    expect(r.shellPrecheckDeny).toBeUndefined()
    expect(r.facts.signals.some((s) => s.kind === 'shell-unsupported-structure')).toBe(true)
  })
})
