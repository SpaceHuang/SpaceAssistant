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

/** 把事实集合映射为"信号 token 集合"，供 `match.signals` 的包含语义匹配。 */
export function signalTokenSet(facts: ContentFacts): Set<string> {
  const tokens = new Set<string>()
  for (const signal of facts.signals) {
    switch (signal.kind) {
      case 'script-analysis':
        // 把 script-analysis 的子档位（clean/suspicious/dangerous）作为独立 token 暴露，
        // 使规则能用 `signals:['clean']` / `['dangerous']` 匹配。
        tokens.add(signal.signal)
        break
      case 'lark-subcommand':
        tokens.add(signal.kind)
        tokens.add(`lark-${signal.impact}`)
        // high_impact / unknown 归并到 write 域（fail-closed，与 isOutboundWriteTool 一致）
        if (signal.impact !== 'read') tokens.add('lark-write')
        break
      case 'browser-action':
        tokens.add(signal.kind)
        tokens.add(`browser-${signal.action}`)
        if (signal.action === 'act' && signal.dangerous) tokens.add('browser-act-dangerous')
        break
      default:
        tokens.add(signal.kind)
    }
  }
  return tokens
}

function hasDangerousSignal(facts: ContentFacts): boolean {
  return signalTokenSet(facts).has('dangerous')
}

/** 从事实推导候选缓存键（规范化签名不落原始输入）。 */
export function deriveCacheKeys(
  facts: ContentFacts,
  sessionId?: string,
  lane?: ExecutionLane
): CacheKey[] {
  const keys: CacheKey[] = []
  for (const signal of facts.signals) {
    switch (signal.kind) {
      case 'command-sequence':
        // B1：仅当命令序列为单分段、无元语法且可持久化信任时，才派生 shell-command exact 缓存键。
        // 复合命令（`a && b`、管道）不得因任一分段被信任而放行整条命令（变体绕过硬性要求）。
        if (signal.persistable && signal.commands.length === 1) {
          const cmd = signal.commands[0]!
          if (cmd.signature) keys.push({ kind: 'shell-command', verb: cmd.signature, level: 'exact' })
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
        // B4：敏感文件（sensitive-file zone）不派生任何缓存键——既不给记忆档位，也不消费已有条目。
        if (signal.zone === 'sensitive-file') break
        keys.push({ kind: 'path', path: signal.path, level: 'file' })
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
export function buildMemoryTiers(facts: ContentFacts, sessionId?: string, lane?: ExecutionLane): MemoryTier[] {
  if (facts.signals.some((s) => s.kind === 'script-network' || s.kind === 'script-uncertified')) {
    return []
  }
  let keys = deriveCacheKeys(facts, sessionId, lane)
  // B4：远程链路（IM 记N）不开放全局持久档——远程确认写出的持久 allow 会反向放行桌面与
  // 其他链路（lookup 只按 key_json 匹配），旧行为远程从不写域名/路径信任。仅保留会话级档位。
  if (lane === 'wechat' || lane === 'feishu') {
    keys = keys.filter((k) => 'sessionId' in k && Boolean(k.sessionId))
  }
  return keys.map((key) => ({
    key,
    label: memoryTierLabel(key)
  }))
}

function ruleMatchesInvocation(
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
  if (m.signals) {
    const tokens = signalTokenSet(facts)
    if (!m.signals.every((s) => tokens.has(s))) return false
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

/** askUnless：门控满足时把 ask 降为 allow（"问除非不满足条件"）。 */
function askUnlessHolds(rule: PolicyRule, deps: PolicyEngineDeps): boolean {
  if (!rule.askUnless) return false
  const au = rule.askUnless
  const configOk = deps.config[au.config] === au.equals
  if (!configOk) return false
  if (au.andMigrationComplete && !deps.migrationComplete) return false
  return true
}

function requireConfirm(
  rule: PolicyRule,
  facts: ContentFacts,
  sessionId?: string,
  lane?: ExecutionLane
): Decision {
  return {
    type: 'require-confirm',
    ruleId: rule.id,
    riskLevel: facts.baseRiskLevel,
    facts,
    memoryTiers: buildMemoryTiers(facts, sessionId, lane),
    timeoutMs: null
  }
}

function autoAllow(ruleId: string, facts: ContentFacts, cacheKey?: CacheKey): Decision {
  return { type: 'auto-allow', ruleId, reason: ruleId, ...(cacheKey ? { cacheKey } : {}) }
}

function deny(ruleId: string, reason: string): Decision {
  return { type: 'deny', ruleId, reason }
}

function lookupCache(
  facts: ContentFacts,
  cache: DecisionCacheView,
  sessionId?: string,
  lane?: ExecutionLane
): Decision | null {
  for (const key of deriveCacheKeys(facts, sessionId, lane)) {
    const entry = cache.lookup(key)
    if (entry && entry.decision === 'allow') return autoAllow('cache-hit', facts, key)
    if (entry && entry.decision === 'deny') return deny('cache-hit', '缓存记忆为拒绝')
  }
  return null
}

function applyDefault(facts: ContentFacts, sessionId?: string, lane?: ExecutionLane): Decision {
  const tokens = signalTokenSet(facts)
  if (tokens.has('extraction-failed')) {
    return requireConfirm(
      { id: 'default-extraction-failed', when: 'invocation', action: 'ask', reason: '提取失败，信息不足' },
      facts,
      sessionId,
      lane
    )
  }
  // 缺元数据 / 无信号一律按"信息不足宁可多问"处理
  if (facts.actionClass === 'read' || facts.actionClass === 'outbound') {
    return autoAllow('default-read-outbound-allow', facts)
  }
  return requireConfirm(
    { id: 'default-write-execute-ask', when: 'invocation', action: 'ask', reason: '默认按动作类别询问' },
    facts,
    sessionId,
    lane
  )
}

/**
 * 工具调用时机（invocation）判定：纯函数，无副作用。
 *
 * 步骤（约定 4）：硬拒绝 → 缓存 → 能力声明 → 自动审批器 → 链路软约束 → 默认表。
 * 缓存查询永远排在硬拒绝之后；auto-evaluator 命中不产生 Decision，评估器不裁决则交还规则链。
 */
export function decide(
  facts: ContentFacts,
  context: ExecutionContext,
  rules: PolicyRule[],
  deps: PolicyEngineDeps
): Decision {
  const invocationRules = rules.filter((r) => r.when === 'invocation')

  // 第 1 步：硬拒绝（先于任何缓存查询，安全不变量）
  if (hasDangerousSignal(facts)) return deny('dangerous-signal', '事实含危险信号，硬拒绝')
  const deniedTools = deps.config.deniedTools
  if (Array.isArray(deniedTools) && deniedTools.includes(facts.toolName)) {
    return deny('denied-tools', `${facts.toolName} 已在禁用列表`)
  }
  const laneHardDeny = invocationRules.find(
    (r) => r.locked && r.action === 'deny' && ruleMatchesInvocation(r, facts, context, deps)
  )
  if (laneHardDeny) return deny(laneHardDeny.id, laneHardDeny.reason)

  // 第 2 步：缓存命中（会话级键按 context.sessionId 绑定）
  const cacheHit = lookupCache(facts, deps.cache, context.sessionId, context.lane)
  if (cacheHit) return cacheHit

  // 第 3 步：能力声明放行（套餐 B 预留，本期无人写入）
  const caps = context.declaredCapabilities
  if (caps && caps.length > 0 && caps.some((c) => c.actionClass === facts.actionClass)) {
    return autoAllow('declared-capability', facts)
  }

  // 第 4 步：自动审批器（auto-evaluator）。命中不产生 Decision；评估器批准才返回，否则交还规则链。
  const autoRules = invocationRules.filter((r) => r.action === 'auto-evaluator')
  for (const rule of autoRules) {
    if (!ruleMatchesInvocation(rule, facts, context, deps)) continue
    if (deps.autoEvaluator) {
      const res = deps.autoEvaluator(facts, context)
      if (res.approve) return autoAllow(rule.id, facts)
    }
    // 约定 2：评估器不裁决 → 继续评估后续条目（M3，不再 break 截断后续 auto 条目），最终通常落到默认表 ask
    continue
  }

  // 第 5 步：链路软约束（只影响体验，纯决策层无操作）

  // 第 6 步：默认表（ask / allow，首条命中即返回）
  const defaultRules = invocationRules.filter((r) => r.action === 'ask' || r.action === 'allow')
  for (const rule of defaultRules) {
    if (!ruleMatchesInvocation(rule, facts, context, deps)) continue
    if (rule.action === 'ask') {
      return askUnlessHolds(rule, deps)
        ? autoAllow(rule.id, facts)
        : requireConfirm(rule, facts, context.sessionId, context.lane)
    }
    if (rule.action === 'allow') return autoAllow(rule.id, facts)
  }

  return applyDefault(facts, context.sessionId, context.lane)
}

/**
 * 消息入口时机（ingress）判定：输入是接续事实（lane + origin），无工具调用。
 * 只消费 `when === 'ingress'` 的规则，首条命中即返回；未命中默认放行。
 */
export function decideIngress(
  facts: IngressFacts,
  rules: PolicyRule[]
): { action: 'allow' | 'deny'; ruleId: string; reason: string } {
  for (const rule of rules) {
    if (rule.when !== 'ingress') continue
    const m = rule.match
    if (m?.lane && !m.lane.includes(facts.lane)) continue
    if (m?.origin && facts.origin.kind !== m.origin) continue
    return { action: rule.action === 'deny' ? 'deny' : 'allow', ruleId: rule.id, reason: rule.reason }
  }
  return { action: 'allow', ruleId: 'ingress-default-allow', reason: '默认放行' }
}
