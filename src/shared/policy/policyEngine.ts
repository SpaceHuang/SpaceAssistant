import type {
  CacheKey,
  ContentFacts,
  Decision,
  DecisionCacheView,
  ExecutionContext,
  ExecutionLane,
  IngressFacts,
  MemoryTier,
  PolicyEngineDeps,
  PolicyRule
} from '../confirmation/types'
import { memoryTierLabel } from '../confirmation/labels'
import { deriveMemoryEligibility } from './memoryEligibility'

export interface InvocationPolicyConstraints {
  readonly mandatoryConfirmationRuleId?: string
  readonly memory: {
    readonly canRead: boolean
    readonly canOffer: boolean
    readonly canWrite: boolean
    readonly reason?: string
  }
}

/** 把事实集合映射为"信号 token 集合"，供 `match.signals` 的包含语义匹配。 */
export function signalTokenSet(facts: ContentFacts): Set<string> {
  const tokens = new Set<string>()
  const hasVerifiedReadOnlyMcpDescriptor = facts.signals.some((signal) => signal.kind === 'mcp-readonly')
  for (const signal of facts.signals) {
    switch (signal.kind) {
      case 'script-analysis':
        // 把 script-analysis 的子档位（clean/suspicious/dangerous）作为独立 token 暴露，
        // 使规则能用 `signals:['clean']` / `['dangerous']` 匹配。
        tokens.add(signal.signal)
        break
      case 'path-target':
        tokens.add(signal.kind)
        tokens.add(`path-target:${signal.zone}`)
        break
      case 'read-target-scope':
        tokens.add(signal.kind)
        tokens.add(`read-target-scope:${signal.scope}`)
        break
      case 'read-target-kind':
        tokens.add(signal.kind)
        tokens.add(`read-target-kind:${signal.targetKind}`)
        break
      case 'write-target-scope':
        tokens.add(signal.kind)
        tokens.add(`write-target-scope:${signal.scope}`)
        break
      case 'automation-output-binding':
        tokens.add(signal.kind)
        tokens.add(`automation-output-binding:${signal.status}`)
        break
      case 'automation-shell-permission':
        tokens.add(signal.kind)
        tokens.add(`automation-shell-permission:${signal.status}`)
        break
      case 'automation-grep-permission':
        tokens.add(signal.kind)
        tokens.add(`automation-grep-permission:${signal.status}`)
        break
      case 'automation-script-permission':
        tokens.add(signal.kind)
        tokens.add(`automation-script-permission:${signal.status}`)
        break
      case 'automation-mcp-permission':
        tokens.add(signal.kind)
        tokens.add(`automation-mcp-permission:${signal.status}`)
        break
      case 'grep-invocation':
        tokens.add(signal.kind)
        break
      case 'policy-tier':
        tokens.add(`policy-tier:${signal.tier}`)
        break
      case 'outbound-content':
        tokens.add(`outbound-inspection:${signal.inspectionCoverage}`)
        if (signal.inspectionCoverage !== 'complete') tokens.add('outbound-inspection-incomplete')
        if (signal.evidenceKinds.length > 0) tokens.add('outbound-evidence-present')
        for (const evidence of signal.evidenceKinds) tokens.add(`outbound-evidence:${evidence}`)
        break
      case 'wechat-media-content-assessment':
        tokens.add(signal.kind)
        tokens.add(`wechat-media-content-assessment:${signal.inspectionCoverage}`)
        tokens.add(`wechat-media-content-digest:${signal.contentDigest}`)
        tokens.add(`outbound-inspection:${signal.inspectionCoverage}`)
        if (signal.inspectionCoverage !== 'complete') tokens.add('outbound-inspection-incomplete')
        if (signal.evidenceKinds.length > 0) tokens.add('outbound-evidence-present')
        for (const evidence of signal.evidenceKinds) tokens.add(`outbound-evidence:${evidence}`)
        break
      case 'wechat-media-content':
        tokens.add(signal.kind)
        break
      case 'wechat-media-identity':
        tokens.add(signal.kind)
        break
      case 'wechat-media-review-binding':
        tokens.add(signal.kind)
        tokens.add(`wechat-media-review-binding:${signal.status}`)
        break
      case 'wechat-media-review-materials':
        tokens.add(signal.kind)
        tokens.add(`wechat-media-review-materials:${signal.status}`)
        break
      case 'write-target-new':
      case 'write-target-existing':
      case 'write-target-unsupported':
        tokens.add(signal.kind)
        break
      case 'command-effect':
        tokens.add(signal.kind)
        tokens.add(`command-effect:${signal.effect}`)
        break
      case 'im-shell-review-candidate':
        tokens.add(signal.kind)
        tokens.add(`im-shell-review-candidate:${signal.command}`)
        break
      case 'path-outside-heuristic':
        tokens.add(signal.kind)
        break
      case 'feishu-media-target':
        tokens.add(signal.kind)
        tokens.add(`feishu-media-target:${signal.boundary}`)
        break
      case 'wechat-media-target':
        tokens.add(signal.kind)
        tokens.add(`wechat-media-target:${signal.boundary}`)
        tokens.add(`wechat-media-target-kind:${signal.targetKind}`)
        break
      case 'workdir-profile-target':
        tokens.add(signal.kind)
        tokens.add(`workdir-profile-target:${signal.status}`)
        break
      case 'script-path-extraction':
        tokens.add(signal.kind)
        tokens.add(`script-path-extraction:${signal.completeness}`)
        if (signal.dynamicAccess) tokens.add('script-dynamic-access')
        if (signal.unknownReason) tokens.add(`script-path-extraction:${signal.unknownReason}`)
        else if (signal.completeness === 'unknown') tokens.add('script-path-extraction:unclassified')
        break
      case 'script-path-declaration':
        tokens.add(signal.kind)
        tokens.add(`script-path-declaration:${signal.scope}`)
        if (signal.consistent) tokens.add('script-path-declaration-consistent')
        break
      case 'script-language-analysis':
        tokens.add(signal.kind)
        tokens.add(`script-language-analysis:${signal.status}`)
        tokens.add(`script-language:${signal.language}`)
        break
      case 'lark-subcommand':
        tokens.add(signal.kind)
        tokens.add(`lark-${signal.impact}`)
        if (signal.category) tokens.add(`lark-category:${signal.category}`)
        if (signal.impact === 'low_write' && signal.completeness === 'complete' &&
          (signal.category === 'doc_write' || signal.category === 'calendar')) tokens.add('lark-standard-low-write')
        if (signal.messageTarget) tokens.add(`lark-message-target:${signal.messageTarget}`)
        // high_impact / unknown 归并到 write 域（fail-closed，与 isOutboundWriteTool 一致）
        if (signal.impact !== 'read') tokens.add('lark-write')
        break
      case 'toolkit-capability':
        // toolkit.call 能力级信号：网关 + 子实体（需求 §5）。
        // `toolkit-capability:${id}` 支持按能力定制策略；read/act 二值由描述符风险级决定。
        tokens.add(signal.kind)
        tokens.add(`toolkit-capability:${signal.capabilityId}`)
        tokens.add(signal.risk === 'act' ? 'toolkit-act' : 'toolkit-read')
        break
      case 'mcp-invocation':
        tokens.add(signal.kind)
        tokens.add(`mcp-query-source:${signal.querySource}`)
        tokens.add(`mcp-account-authorization:${signal.accountAuthorization}`)
        // This candidate token requires the independent descriptor-validation signal plus all host-derived
        // provenance and completeness facts. `readOnlyHint` alone never creates this token.
        if (
          hasVerifiedReadOnlyMcpDescriptor && signal.querySource === 'public' &&
          signal.accountAuthorization === 'authorized' && signal.sideEffect === 'read' &&
          signal.completeness === 'complete' && signal.dataDestinations.length === 0
        ) tokens.add('mcp-public-read')
        if (signal.completeness === 'capability-description-stale') tokens.add('mcp-capability-description-stale')
        break
      case 'browser-action':
        tokens.add(signal.kind)
        tokens.add(`browser-${signal.action}`)
        if (signal.action === 'act' && signal.dangerous === false && signal.completeness === 'complete' &&
          (signal.sideEffect === 'read' || signal.sideEffect === 'navigate')) tokens.add('browser-act-low-risk')
        if (signal.action === 'act' && signal.dangerous) tokens.add('browser-act-dangerous')
        break
      case 'command-sequence':
        tokens.add(signal.kind)
        for (const command of signal.commands) {
          if (command.connector) tokens.add(`shell-connector:${command.connector}`)
        }
        break
      default:
        tokens.add(signal.kind)
    }
  }
  return tokens
}

/** 从事实推导候选缓存键（规范化签名不落原始输入）。 */
export function deriveCacheKeys(
  facts: ContentFacts,
  sessionId?: string,
  lane?: ExecutionLane,
  constraints?: InvocationPolicyConstraints
): CacheKey[] {
  if (constraints && !constraints.memory.canRead) return []
  const keys: CacheKey[] = []
  const scriptPathsUnknown = facts.signals.some((signal) => signal.kind === 'script-path-extraction' && signal.completeness === 'unknown')
  for (const signal of facts.signals) {
    switch (signal.kind) {
      case 'command-sequence':
        // B1：仅当命令序列为单分段、无元语法且可持久化信任时，才派生 shell-command exact 缓存键。
        // 复合命令（`a && b`、管道）不得因任一分段被信任而放行整条命令（变体绕过硬性要求）。
        if (signal.persistable && signal.commands.length === 1) {
          const cmd = signal.commands[0]!
          if (cmd.signature) {
            const verb = cmd.profileNamespace ? `${cmd.profileNamespace}:${cmd.signature}` : cmd.signature
            keys.push({ kind: 'shell-command', verb, level: 'exact' })
          }
          else if (cmd.verb) keys.push({ kind: 'shell-command', verb: cmd.verb, level: 'exact' })
        }
        break
      case 'network-egress':
        // 浏览器 navigate 域名信任档（domain-any-action）；会话级条目按 sessionId 绑定。
        for (const domain of signal.domains) {
          keys.push({ kind: 'domain', domain, level: 'domain-any-action' })
          if (sessionId) keys.push({ kind: 'domain', domain, level: 'domain-any-action', sessionId })
        }
        break
      case 'browser-action':
        // 浏览器 act 域名信任档（domain+action），与 navigate 信任档分离（等价现状
        // trustedDomains / actTrustedDomains 两张独立清单，不得互相放行）。
        if (signal.action === 'act' && signal.host && !signal.dangerous) {
          keys.push({ kind: 'domain', domain: signal.host, level: 'domain+action' })
          if (sessionId) {
            keys.push({ kind: 'domain', domain: signal.host, level: 'domain+action', sessionId })
          }
        }
        break
      case 'mcp-tool':
        // MCP 会话信任：仅会话级（等价 mcpSessionTrust 内存语义），无 sessionId 不派生键。
        if (sessionId) {
          keys.push({ kind: 'mcp-tool', serverId: signal.serverId, toolName: signal.toolName, sessionId })
        }
        break
      case 'path-target':
        if (scriptPathsUnknown) break
        // B4：敏感文件（sensitive-file zone）不派生任何缓存键——既不给记忆档位，也不消费已有条目。
        if (signal.zone === 'sensitive-file') break
        keys.push({ kind: 'path', path: signal.path, level: 'file' })
        break
      case 'script-path-extraction':
        if (signal.completeness === 'unknown' && signal.unknownReason === 'unmodeled-call' && !signal.dynamicAccess && signal.contentDigest && /^[a-f0-9]{64}$/.test(signal.contentDigest) && signal.workdirDigest && /^[a-f0-9]{64}$/.test(signal.workdirDigest) && sessionId) {
          keys.push({ kind: 'script-content', digest: signal.contentDigest, workdirDigest: signal.workdirDigest, sessionId })
        }
        break
      default:
        break
    }
  }
  // 远程写会话信任：远程链路写文件时派生会话级 remote-write 键（用户记N 选「记住本会话写文件」后，
  // 该会话后续写文件免确认）。置于单条路径档之后（窄档优先），且不派生持久键，避免宽范围叠加。
  if ((lane === 'wechat' || lane === 'feishu') && sessionId) {
    if (facts.toolName === 'write_file' || facts.toolName === 'edit_file') {
      keys.push({ kind: 'remote-write', sessionId })
    }
  }
  return keys
}

/**
 * 依据候选缓存键生成确认界面的记忆档位（默认最窄可用档）。
 * run_script 记忆封顶（§5.3）：携带 script-network / script-uncertified 信号的调用
 * 强制"仅此一次"、不开放任何记忆档位——这两条规则非 locked 且位于缓存检查之后，
 * 开放记忆会让"记住"绕过网络命中确认与未认证降级，属安全松动。
 */
export function buildMemoryTiers(
  facts: ContentFacts,
  sessionId?: string,
  lane?: ExecutionLane,
  constraints?: InvocationPolicyConstraints
): MemoryTier[] {
  if (constraints && !constraints.memory.canOffer) return []
  const eligibility = deriveMemoryEligibility(facts, lane ?? 'desktop')
  if (eligibility.eligibility === 'none') return []
  let keys = deriveCacheKeys(facts, sessionId, lane)
  // B4：远程链路（IM 记N）不开放全局持久档——远程确认写出的持久 allow 会反向放行桌面与
  // 其他链路（lookup 只按 key_json 匹配），旧行为远程从不写域名/路径信任。仅保留会话级档位。
  if (eligibility.eligibility === 'session') {
    keys = keys.filter((k) => 'sessionId' in k && Boolean(k.sessionId))
  }
  return keys.map((key) => ({
    key,
    label: memoryTierLabel(key)
  }))
}

export function ruleMatchesInvocation(
  rule: PolicyRule,
  facts: ContentFacts,
  context: ExecutionContext,
  deps: PolicyEngineDeps
): boolean {
  const m = rule.match
  if (!m) return true
  if (m.lane && !m.lane.includes(context.lane)) return false
  if (m.origin && context.origin.kind !== m.origin) return false
  if (m.toolName) {
    const names = Array.isArray(m.toolName) ? m.toolName : [m.toolName]
    if (!names.includes(facts.toolName)) return false
  }
  if (m.actionClass && facts.actionClass !== m.actionClass) return false
  const tokens = m.signals || m.excludeSignals ? signalTokenSet(facts) : undefined
  if (m.signals) {
    if (!tokens) return false
    if (!m.signals.every((s) => tokens.has(s))) return false
    if (m.excludeSignals?.some((s) => tokens.has(s))) return false
  } else if (m.excludeSignals && tokens) {
    if (m.excludeSignals.some((s) => tokens.has(s))) return false
  }
  // M1：owner-only 出站目标约束——仅信源为 direct-owner 时命中
  if (m.target === 'owner-only' && context.origin.kind !== 'direct-owner') return false
  // 门控：configRequires 不满足即不命中（数组语义"全部满足"）
  if (rule.configRequires) {
    const reqs = Array.isArray(rule.configRequires) ? rule.configRequires : [rule.configRequires]
    for (const req of reqs) {
      if (deps.config[req.config] !== req.equals) return false
    }
  }
  // 门控：requiresContext 消费上下文只读事实
  if (
    rule.requiresContext?.outboundWriteBudgetExhausted === true &&
    !(context.outboundWriteBudgetRemaining != null && context.outboundWriteBudgetRemaining <= 0)
  ) {
    return false
  }
  return true
}

/** Classify a matched policy rule before it reaches an executor or confirmation channel. */
export function resolvePolicyOutcome(rule: PolicyRule): {
  disposition: 'forbidden' | 'human-required' | 'auto-eligible'
  cause: string
  reason: string
} {
  if (rule.action === 'deny') {
    return { disposition: 'forbidden', cause: rule.denyClass ?? 'hard-deny', reason: rule.reason }
  }
  if (rule.humanRequired || rule.action === 'ask' || rule.action === 'confirm-every-time') {
    return { disposition: 'human-required', cause: rule.humanRequired ? 'human-required' : rule.id, reason: rule.reason }
  }
  return { disposition: 'auto-eligible', cause: rule.id, reason: rule.reason }
}

/** askUnless：门控满足时把 ask 降为 allow（"问除非不满足条件"）。 */
function askUnlessHolds(rule: PolicyRule, deps: PolicyEngineDeps): boolean {
  if (!rule.askUnless) return false
  const au = rule.askUnless
  const configOk = deps.config[au.config] === au.equals
  if (!configOk) return false
  if (au.andMigrationComplete && !deps.migrationComplete) return false
  return true
}

/** 回答者派生（§2.2）：ask 类动作按 lane 落回答者——automation 无人可问恒为 agent，其余人工。 */
export function askAnswererFor(lane?: ExecutionLane): 'user' | 'agent' {
  return lane === 'automation' ? 'agent' : 'user'
}

function requireConfirm(
  rule: PolicyRule,
  facts: ContentFacts,
  sessionId?: string,
  lane?: ExecutionLane,
  constraints?: InvocationPolicyConstraints,
  answerer: 'user' | 'agent' = rule.answerer ?? askAnswererFor(lane)
): Decision {
  const outcome = resolvePolicyOutcome(rule)
  return {
    type: 'require-confirm',
    ruleId: rule.id,
    answerer,
    disposition: answerer === 'user' ? 'human-required' : 'auto-eligible',
    cause: outcome.cause,
    reason: outcome.reason,
    riskLevel: facts.baseRiskLevel,
    facts,
    memoryTiers: buildMemoryTiers(facts, sessionId, lane, constraints),
    timeoutMs: null
  }
}

function autoAllow(ruleId: string, _facts: ContentFacts, cacheKey?: CacheKey): Decision {
  return { type: 'auto-allow', ruleId, reason: ruleId, disposition: 'auto-eligible', cause: ruleId, ...(cacheKey ? { cacheKey } : {}) }
}

function deny(ruleId: string, reason: string, cause = 'hard-deny'): Decision {
  return { type: 'deny', ruleId, reason, disposition: 'forbidden', cause }
}

function lookupCache(
  facts: ContentFacts,
  cache: DecisionCacheView,
  sessionId?: string,
  lane?: ExecutionLane,
  constraints?: InvocationPolicyConstraints
): Decision | null {
  if (deriveMemoryEligibility(facts, lane ?? 'desktop').eligibility === 'none') return null
  for (const key of deriveCacheKeys(facts, sessionId, lane, constraints)) {
    const entry = cache.lookup(key, lane)
    if (entry && entry.decision === 'allow') return autoAllow('cache-hit', facts, key)
    if (entry && entry.decision === 'deny') return deny('cache-hit', '缓存记忆为拒绝')
  }
  return null
}

function applyDefault(
  facts: ContentFacts,
  deps: PolicyEngineDeps,
  context: ExecutionContext
): Decision {
  const { sessionId, lane } = context
  const tokens = signalTokenSet(facts)
  if (tokens.has('extraction-failed')) {
    // M3 不变换例外：提取失败 = 输入畸形/对抗性，「信息不足 → 问人」，任何档位恒落人工
    // （automation 经 lane 规则落 agent，不会到达此兜底——automation-default-confirm 全量拦截）。
    return requireConfirm(
      { id: 'default-extraction-failed', when: 'invocation', action: 'ask', reason: '提取失败，信息不足' },
      facts,
      sessionId,
      lane,
      undefined,
      'user'
    )
  }
  // 缺元数据 / 无信号一律按"信息不足宁可多问"处理
  if (facts.actionClass === 'read' || facts.actionClass === 'outbound') {
    return autoAllow('default-read-outbound-allow', facts)
  }
  // default-write-execute-ask 照常参与档位变换（desktop standard → auto-evaluator，§5.2）：
  // 变换后先走快通道（确定性预判），未裁决交审批 Agent（answerer=agent）。
  const effective = deps.transform ? deps.transform({ action: 'ask' }) : 'ask'
  if (effective === 'auto-evaluator') {
    const defaultWriteReviewRule = {
      id: 'default-write-execute-ask',
      when: 'invocation' as const,
      action: 'ask' as const,
      reviewCacheSources: ['agent'] as readonly import('../confirmation/types').ReviewCacheSource[],
      reason: '默认按动作类别询问'
    }
    const regularWorkspaceFile = context.policyTier === 'standard' &&
      (facts.toolName === 'edit_file' || facts.toolName === 'write_file') &&
      facts.signals.some((signal) => signal.kind === 'path-target' && signal.zone === 'workdir-normal')
    if (regularWorkspaceFile && deps.reviewScopeGrant && defaultWriteReviewRule.reviewCacheSources.includes(deps.reviewScopeGrant.source)) {
      return { type: 'auto-allow', ruleId: 'review-cache-scope-grant-v1',
        cause: 'review-cache-current-task-constraint-v1', reason: 'approved review scope matched' }
    }
    if (deps.autoEvaluator) {
      const res = deps.autoEvaluator(facts, context)
      if (res.approve) return autoAllow('default-write-execute-ask', facts)
    }
    return requireConfirm(
      { id: 'default-write-execute-ask', when: 'invocation', action: 'ask', reason: '默认按动作类别询问' },
      facts,
      sessionId,
      lane,
      undefined,
      'agent'
    )
  }
  if (effective === 'allow') return autoAllow('default-write-execute-ask', facts)
  if (effective === 'deny') return deny('default-write-execute-ask', '默认兜底按档位变换为拒绝')
  return requireConfirm(
    { id: 'default-write-execute-ask', when: 'invocation', action: 'ask', reason: '默认按动作类别询问' },
    facts,
    sessionId,
    lane
  )
}

/** 在 invocation 层一次性推导确认与记忆约束，避免 cache/UI/writer 各自判断。 */
export function deriveInvocationPolicyConstraints(
  facts: ContentFacts,
  context: ExecutionContext,
  rules: readonly PolicyRule[],
  deps: PolicyEngineDeps
): InvocationPolicyConstraints {
  const eligibility = deriveMemoryEligibility(facts, context.lane)
  const memory = eligibility.eligibility === 'none'
    ? { canRead: false, canOffer: false, canWrite: false, reason: eligibility.reasons.join(',') }
    : { canRead: true, canOffer: true, canWrite: true, ...(eligibility.reasons.length ? { reason: eligibility.reasons.join(',') } : {}) }
  const mandatory = rules
    .filter((rule) => rule.when === 'invocation' && rule.locked && rule.action === 'confirm-every-time')
    .find((rule) => ruleMatchesInvocation(rule, facts, context, deps))
  if (mandatory) {
    return {
      mandatoryConfirmationRuleId: mandatory.id,
      memory: { canRead: false, canOffer: false, canWrite: false, reason: 'confirm-every-time' }
    }
  }
  return { memory }
}

/**
 * 工具调用时机（invocation）判定：纯函数，无副作用。
 *
 * 求值顺序：拒绝规则 → 人工 ask/显式自动审核 → 例外缓存 → 自动审批器 → 默认表。
 * 所有命中的 deny 和未声明缓存例外的 ask 都先于 allow 缓存；cacheableAsk 仅为规则声明的记忆路径。
 * auto-evaluator 命中不产生 Decision，评估器不裁决则交还规则链。
 */
export function decide(
  facts: ContentFacts,
  context: ExecutionContext,
  rules: PolicyRule[],
  deps: PolicyEngineDeps
): Decision {
  const policyFacts = context.policyTier
    ? { ...facts, signals: [...facts.signals, { kind: 'policy-tier' as const, tier: context.policyTier }] }
    : facts
  const invocationRules = rules.filter((r) => r.when === 'invocation')
  const matchedRule = (r: PolicyRule) => {
    return ruleMatchesInvocation(r, policyFacts, context, deps)
  }
  const constraints = deriveInvocationPolicyConstraints(policyFacts, context, rules, deps)
  // 第 1 步：拒绝列表是系统策略边界，任何自定义规则都不能绕过。
  const deniedTools = deps.config.deniedTools
  if (Array.isArray(deniedTools) && deniedTools.includes(facts.toolName)) {
    return deny('denied-tools', `${facts.toolName} 已在禁用列表`)
  }
  // Resolve matched actions once so deny, explicit user choices and fallback
  // arbitration use the same effective-action interpretation.
  const matchedActions = invocationRules
    .filter((rule) => {
      if (!matchedRule(rule)) return false
      if (rule.userOverride || !rule.defaultActionExcludeSignals?.some((signal) => signalTokenSet(policyFacts).has(signal))) return true
      const effectiveAction = deps.transform ? deps.transform(rule) : rule.action
      return effectiveAction !== 'ask' && effectiveAction !== 'auto-evaluator'
    })
    .map((rule) => {
      const transformedAction = rule.userOverride ? rule.action : deps.transform ? deps.transform(rule) : rule.action
      return { rule, action: transformedAction, transformed: !rule.userOverride && transformedAction !== rule.action }
    })
  const byAction = (entries: typeof matchedActions, action: PolicyRule['action']) => entries
    .filter((entry) => entry.action === action || action === 'ask' && entry.action === 'confirm-every-time')
    .sort((a, b) => Number(b.rule.humanRequired === true) - Number(a.rule.humanRequired === true)
      || Number(b.rule.locked === true) - Number(a.rule.locked === true)
      || Number(b.transformed) - Number(a.transformed)
      || Number(Boolean(b.rule.askUnless)) - Number(Boolean(a.rule.askUnless))
      || Number((b.rule.match?.signals?.length ?? 0) + (b.rule.match?.toolName ? 1 : 0) + (b.rule.match?.lane?.length ? 1 : 0) + (b.rule.match?.actionClass ? 1 : 0))
        - Number((a.rule.match?.signals?.length ?? 0) + (a.rule.match?.toolName ? 1 : 0) + (a.rule.match?.lane?.length ? 1 : 0) + (a.rule.match?.actionClass ? 1 : 0))
      || a.rule.id.localeCompare(b.rule.id))
    .map(({ rule }) => rule)[0]
  const selectedDeny = byAction(matchedActions, 'deny')
  if (selectedDeny) return deny(selectedDeny.id, selectedDeny.reason)
  const humanFloor = matchedActions
    .filter(({ rule, action }) => action === 'confirm-every-time' || action === 'ask' && rule.humanRequired)
    .map(({ rule }) => rule)
    .sort((a, b) => Number(b.locked === true) - Number(a.locked === true)
      || Number((b.match?.signals?.length ?? 0) + (b.match?.toolName ? 1 : 0) + (b.match?.lane?.length ? 1 : 0))
        - Number((a.match?.signals?.length ?? 0) + (a.match?.toolName ? 1 : 0) + (a.match?.lane?.length ? 1 : 0))
      || a.id.localeCompare(b.id))[0]
  if (humanFloor) return requireConfirm(humanFloor, facts, context.sessionId, context.lane, constraints, 'user')

  // Every effective action participates in the same priority regardless of
  // whether it came from a package default, a user override, or a transform.
  // Explicit rule overrides remain authoritative over previous user memory.
  const actionableAsks = matchedActions.filter(({ rule }) => !rule.humanRequired && rule.id !== 'automation-default-confirm' && !askUnlessHolds(rule, deps))
  const selectedAsk = byAction(actionableAsks.filter(({ rule }) => rule.userOverride), 'ask')
    ?? byAction(actionableAsks, 'ask')
  const matchingAsks = actionableAsks.filter(({ action }) => action === 'ask' || action === 'confirm-every-time')
  const onlyExplicitlyCacheableAsks = matchingAsks.length > 0 && matchingAsks.every(({ rule }) =>
    rule.cacheableAsk === true && !rule.userOverride && !rule.humanRequired
  )
  const askUnlessAllows = matchedActions.filter(({ action, rule }) =>
    !rule.humanRequired && !rule.locked && (action === 'ask' || action === 'auto-evaluator') && askUnlessHolds(rule, deps))
  // Only rules that explicitly declare a user-memory exception may consume
  // cached allow before asking. Generic or user-selected asks always win.
  const cacheHit = selectedAsk && !onlyExplicitlyCacheableAsks
    ? null
    : selectedAsk?.cacheableAsk
    ? lookupCache(facts, deps.cache, context.sessionId, context.lane, constraints)
    : lookupCache(facts, deps.cache, context.sessionId, context.lane, constraints)
  if (cacheHit?.type === 'deny') return cacheHit
  const larkMessageOutbound = facts.toolName === 'run_lark_cli' && facts.signals.some((signal) =>
    signal.kind === 'lark-subcommand' && signal.category === 'message'
  )
  const larkMessageNeedsTier = larkMessageOutbound && facts.signals.some((signal) =>
    signal.kind === 'outbound-content' && (
      signal.evidenceKinds.length > 0 || signal.inspectionCoverage !== 'complete'
    )
  )
  const explicitOutboundTier = facts.actionClass === 'outbound' && (!larkMessageOutbound || larkMessageNeedsTier) && context.policyTier && context.policyTier !== 'custom' &&
    (context.policyTier === 'loose' || context.policyTier === 'strict' || context.policyTier === 'standard') &&
    !(facts.toolName === 'browser' || context.lane === 'desktop' && ['read_file', 'grep', 'list_directory'].includes(facts.toolName))

  if (explicitOutboundTier) {
    const tokens = signalTokenSet(policyFacts)
    const hasOutboundSensitivity = tokens.has('outbound-evidence-present')
    const hasIncompleteOutboundFacts = tokens.has('outbound-inspection-incomplete')
    const outboundModes = context.policyTier === 'strict'
      ? ['outbound-sensitive-strict-human', 'outbound-incomplete-strict-human', 'outbound-mode-strict-human']
      : context.policyTier === 'standard'
        ? ['outbound-sensitive-standard-human', 'outbound-incomplete-standard-review', 'outbound-mode-standard-review']
        : ['outbound-sensitive-loose-review', 'outbound-incomplete-loose-review',
        `outbound-mode-${context.policyTier}-${context.policyTier === 'loose' ? 'allow' : 'review'}`]
    const selectedOutboundRuleId = hasOutboundSensitivity
      ? outboundModes.find((id) => id.includes('sensitive'))
      : hasIncompleteOutboundFacts ? outboundModes.find((id) => id.includes('incomplete')) : outboundModes.at(-1)
    const mode = selectedOutboundRuleId ? rules.find((rule) => rule.id === selectedOutboundRuleId) : undefined
    if (mode && matchedRule(mode)) {
      const transformed = deps.transform ? deps.transform(mode) : mode.action
      if (transformed !== 'allow') return requireConfirm(mode, facts, context.sessionId, context.lane, constraints)
    }
  }

  // A scope grant is consumed only after deny, human-required, old memory and outbound
  // checks. Every effective ask in the current policy chain must explicitly permit its source.
  const effectiveReviewRules = matchedActions.filter(({ action, rule }) =>
    (action === 'ask' || action === 'auto-evaluator' || action === 'confirm-every-time') && !askUnlessHolds(rule, deps)
  )
  if (deps.reviewScopeGrant && effectiveReviewRules.length > 0 && effectiveReviewRules.every(({ rule }) =>
    !rule.humanRequired && !rule.userOverride && !rule.locked &&
    rule.reviewCacheSources?.includes(deps.reviewScopeGrant!.source) === true
  )) {
    return { type: 'auto-allow', ruleId: 'review-cache-scope-grant-v1',
      cause: 'review-cache-current-task-constraint-v1', reason: 'approved review scope matched' }
  }

  if (selectedAsk && !(onlyExplicitlyCacheableAsks && cacheHit?.type === 'auto-allow')) {
    return requireConfirm(selectedAsk, facts, context.sessionId, context.lane, constraints,
      selectedAsk.userOverride ? 'user' : selectedAsk.answerer ?? askAnswererFor(context.lane))
  }
  const explicitReviewAutos = matchedActions.filter(({ action, rule }) => action === 'auto-evaluator' &&
    !askUnlessHolds(rule, deps) && (rule.userOverride || rule.action === 'ask' && !rule.cacheableAsk))
    .sort((a, b) => a.rule.id.localeCompare(b.rule.id))
  if (context.lane !== 'automation' && explicitReviewAutos.length > 0) {
    const selectedAuto = explicitReviewAutos[0].rule
    if (deps.autoEvaluator?.(facts, context).approve) return autoAllow(selectedAuto.id, facts)
    return requireConfirm(selectedAuto, facts, context.sessionId, context.lane, constraints, 'agent')
  }
  if (cacheHit) return cacheHit

  if (context.lane !== 'automation') {
    const autoCandidates = matchedActions
      .filter(({ action }) => action === 'auto-evaluator')
      .sort((a, b) => Number((a.rule.match?.signals?.length ?? 0) + (a.rule.match?.toolName ? 1 : 0) + (a.rule.match?.lane?.length ? 1 : 0))
        - Number((b.rule.match?.signals?.length ?? 0) + (b.rule.match?.toolName ? 1 : 0) + (b.rule.match?.lane?.length ? 1 : 0))
        || a.rule.id.localeCompare(b.rule.id))
    let lastAuto: PolicyRule | undefined
    for (const { rule } of autoCandidates) {
      if (askUnlessHolds(rule, deps)) continue
      lastAuto = rule
      if (deps.autoEvaluator?.(facts, context).approve) return autoAllow(rule.id, facts)
    }
    if (lastAuto) return requireConfirm(lastAuto, facts, context.sessionId, context.lane, constraints, 'agent')
  }
  const selectedAskUnlessAllow = askUnlessAllows
    .sort((a, b) => Number(b.rule.askUnless !== undefined) - Number(a.rule.askUnless !== undefined)
      || Number((b.rule.match?.signals?.length ?? 0) + (b.rule.match?.toolName ? 1 : 0) + (b.rule.match?.lane?.length ? 1 : 0))
        - Number((a.rule.match?.signals?.length ?? 0) + (a.rule.match?.toolName ? 1 : 0) + (a.rule.match?.lane?.length ? 1 : 0))
      || a.rule.id.localeCompare(b.rule.id))[0]?.rule
  if (selectedAskUnlessAllow) return autoAllow(selectedAskUnlessAllow.id, facts)
  if (cacheHit) return cacheHit

  if (context.lane !== 'automation') {
    // Among remaining default rules, INV-03 is independent of rule array order.
    const fallbackActions = matchedActions.filter(({ rule }) => !rule.userOverride)
    // A configured allow is an explicit setting, gated by the current facts; apply
    // it before generic review candidates so enabling a scoped exception takes effect.
    const configuredAllow = byAction(fallbackActions.filter(({ action, rule }) => action === 'allow' && rule.configRequires), 'allow')
    if (configuredAllow) return autoAllow(configuredAllow.id, facts)
    const selectedAllow = byAction(fallbackActions, 'allow')
    if (selectedAllow) return autoAllow(selectedAllow.id, facts)
  }

  // 第 2 步：缓存命中（会话级键按 context.sessionId 绑定）
  // 第 3 步：自动审批器（auto-evaluator =「自动」动作）。确定性快通道批准即放行；
  // 未裁决 → 交审批 Agent（require-confirm answerer='agent'，§5.2：不再交还默认表问人）。
  const autoRules = invocationRules.filter((r) => r.action === 'auto-evaluator')
  let lastAutoRule: PolicyRule | undefined
  for (const rule of autoRules) {
    if (!matchedRule(rule)) continue
    if (askUnlessHolds(rule, deps)) continue
    lastAutoRule = rule
    if (deps.autoEvaluator) {
      const res = deps.autoEvaluator(facts, context)
      if (res.approve) return autoAllow(rule.id, facts)
    }
    // 约定 2（M3）：评估器不裁决 → 继续评估后续 auto 条目（多快通道级联）；
    // 全部未裁决则由末次命中条目落 Agent 裁决
    continue
  }
  if (lastAutoRule) {
    return requireConfirm(lastAutoRule, facts, context.sessionId, context.lane, undefined, 'agent')
  }

  // 第 4 步：链路软约束（只影响体验，纯决策层无操作）

  // 第 5 步：默认表（deny / ask / allow，首条命中即返回）。生效动作按档位产出时变换
  // （deps.transform = effectiveActionFor 同源）：standard 桌面的 ask → auto-evaluator
  // 走快通道/审批 Agent，且不改变规则间优先级（mcp-readonly-allow 等先命中条目不受影响）。
  const defaultRules = invocationRules.filter((r) => r.action === 'deny' || r.action === 'ask' || r.action === 'allow')
  for (const rule of defaultRules) {
    if (!matchedRule(rule)) continue
    const effective = deps.transform ? deps.transform(rule) : rule.action
    // askUnless 门控放行先于动作解释：开关已声明「不问」（如 larkCliWriteRequiresConfirm=false）
    // 时无论生效动作是 ask 还是「自动」都直接放行，档位不接管已放行的调用
    if ((effective === 'ask' || effective === 'auto-evaluator') && askUnlessHolds(rule, deps)) {
      return autoAllow(rule.id, facts)
    }
    if (effective === 'ask') {
      return requireConfirm(rule, facts, context.sessionId, context.lane)
    }
    if (effective === 'auto-evaluator') {
      if (deps.autoEvaluator) {
        const res = deps.autoEvaluator(facts, context)
        if (res.approve) return autoAllow(rule.id, facts)
      }
      // 「自动」：确定性快通道未裁决 → 审批 Agent（answerer=agent）
      return requireConfirm(rule, facts, context.sessionId, context.lane, undefined, 'agent')
    }
    if (effective === 'allow') return autoAllow(rule.id, facts)
    if (effective === 'deny') return deny(rule.id, rule.reason)
  }

  return applyDefault(facts, deps, context)
}

/**
 * 消息入口时机（ingress）判定：输入是接续事实（lane + origin），无工具调用。
 * 只消费 `when === 'ingress'` 的规则；任何匹配 deny 优先于 allow，未命中默认放行。
 */
export function decideIngress(
  facts: IngressFacts,
  rules: PolicyRule[]
): { action: 'allow' | 'deny' | 'ask'; ruleId: string; reason: string } {
  const matches = (rule: PolicyRule): boolean => {
    if (rule.when !== 'ingress') return false
    const m = rule.match
    if (m?.lane && !m.lane.includes(facts.lane)) return false
    if (m?.origin && facts.origin.kind !== m.origin) return false
    return true
  }
  const denyRule = rules.find((rule) => rule.action === 'deny' && matches(rule))
  if (denyRule) return { action: 'deny', ruleId: denyRule.id, reason: denyRule.reason }
  const matched = rules.filter(matches)
  const askRule = matched.find((rule) => rule.action === 'ask' || rule.action === 'confirm-every-time' || (!rule.userOverride && rule.humanRequired))
  if (askRule) return { action: 'ask', ruleId: askRule.id, reason: askRule.reason }
  const allowRule = matched.find((rule) => rule.action === 'allow')
  if (allowRule) return { action: 'allow', ruleId: allowRule.id, reason: allowRule.reason }
  return { action: 'allow', ruleId: 'ingress-default-allow', reason: '默认放行' }
}
