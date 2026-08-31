import { decide } from '../../src/shared/policy/policyEngine'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { extractScriptSignals } from './extractors/scriptAnalysisExtractor'
import { runExtractors } from './extractors/runExtractors'
import { analyzeScriptContent, type ScriptAnalysisResult } from '../shell/scriptContentSecurity'
import type {
  AutoEvaluator,
  ContentFacts,
  Decision,
  DecisionCacheView,
  EnvFacts,
  ExecutionContext,
  ExecutionLane,
  FactSignal,
  OriginInfo,
  PolicyEngineDeps,
  ToolActionDescriptor
} from '../../src/shared/confirmation/types'

export interface RunScriptDecisionArgs {
  code: string
  env: EnvFacts
  lane: ExecutionLane
  origin: OriginInfo
  sessionId: string
  config: Record<string, unknown>
  migrationComplete: boolean
  cache?: DecisionCacheView
}

const EMPTY_CACHE: DecisionCacheView = { lookup: () => null }

/**
 * 主循环接线助手：把 run_script 的输入走「事实提取 → 策略判定」直线流程，
 * 返回最终 Decision（供主循环映射为 needsConfirm / 拒绝）。脚本不参与记忆缓存，
 * 因此默认注入空缓存（run_script 记忆封顶见 §5.3）。
 */
export function decideRunScript(args: RunScriptDecisionArgs): {
  decision: Decision
  signals: FactSignal[]
  summary: string
  /** 保留原始分析结论（用于用户可见拒绝消息的桥接；判定本身以 decision 为准）。 */
  rawAnalysis: ScriptAnalysisResult
} {
  const { signals, summary } = extractScriptSignals(args.code, args.env)
  const facts: ContentFacts = {
    toolName: 'run_script',
    actionClass: 'execute',
    baseRiskLevel: 'high',
    signals,
    summary
  }
  const context: ExecutionContext = {
    lane: args.lane,
    origin: args.origin,
    sessionId: args.sessionId
  }
  const deps: PolicyEngineDeps = {
    cache: args.cache ?? EMPTY_CACHE,
    config: args.config,
    migrationComplete: args.migrationComplete
  }
  const decision = decide(facts, context, DEFAULT_POLICY_RULES, deps)
  // 桥接：为保持 P1"无用户可见变化"，拒绝消息沿用现状 analyzeScriptContent 的原始结论
  // （桌面/远程的网络判定差异由规则承载；这里只用于消息格式，不改变判定）。
  const rawAnalysis = analyzeScriptContent(args.code, { remote: args.lane !== 'desktop' })
  return { decision, signals, summary: summary.text, rawAnalysis }
}

export interface DecideToolArgs {
  descriptor: ToolActionDescriptor
  toolInput: Record<string, unknown>
  env: EnvFacts
  lane: ExecutionLane
  origin: OriginInfo
  sessionId: string
  config: Record<string, unknown>
  migrationComplete: boolean
  cache?: DecisionCacheView
  autoEvaluator?: AutoEvaluator
}

/**
 * 主循环接线助手：任意内置工具走「事实提取 → 策略判定」直线流程（§3 总结构）。
 * 返回 Decision + 事实/摘要，供主循环映射为 needsConfirm / 拒绝 / 通道确认。
 */
export function decideTool(args: DecideToolArgs): {
  decision: Decision
  signals: FactSignal[]
  summary: string
} {
  const facts = runExtractors(args.descriptor, args.toolInput, args.env)
  const context: ExecutionContext = {
    lane: args.lane,
    origin: args.origin,
    sessionId: args.sessionId
  }
  const deps: PolicyEngineDeps = {
    cache: args.cache ?? EMPTY_CACHE,
    config: args.config,
    migrationComplete: args.migrationComplete,
    ...(args.autoEvaluator ? { autoEvaluator: args.autoEvaluator } : {})
  }
  return { decision: decide(facts, context, DEFAULT_POLICY_RULES, deps), signals: facts.signals, summary: facts.summary.text }
}
