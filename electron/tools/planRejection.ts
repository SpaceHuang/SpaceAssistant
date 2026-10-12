import { createHash } from 'node:crypto'
import { PlanRejectedError } from '../../packages/agent-sdk/src/turn'
import { RunShellPlanError, type RunShellPlanErrorCode } from './runShellPlan'
import { SHELL_CASE_IDS } from '../shell/shellCaseIds'
import { DialectRetryBreaker, dialectRetryBreaker as sharedDialectRetryBreaker } from '../shell/dialectRetryBreaker'
import { escalatedDialectMismatchHints } from '../shell/shellDialectMismatch'
import { logShellAgentEvent } from '../shell/shellAgentLogger'

/**
 * P0-A（D-1 定案）：可降级为「拒绝即回模型」的 run_shell 计划错误码白名单。
 * 这些错误是模型改写输入即可恢复的（方言混用、配置无效、TUI 需要终端）；
 * 白名单外的 RunShellPlanError 与普通异常保持既有 fatal 语义（如内部契约错误不得污染模型上下文）。
 */
export const RETURNABLE_RUN_SHELL_PLAN_CODES: ReadonlySet<RunShellPlanErrorCode> = new Set([
  'SHELL_DIALECT_MISMATCH',
  'SHELL_PLAN_INVALID',
  'SHELL_INTERACTIVE_TTY_REQUIRED',
  'SHELL_TUI_UNDETECTABLE'
])

/**
 * §4.4(a)：方言错配的 record 落点与「计划失败 → 拒绝」转换同层——
 * 只有该层能同时拿到 details.signals / shellProfileId 与转换结果；
 * 共享 dialectRetryBreaker 单例，与 runShellExecutor（legacy 路径）的计数与成功清除保持一致。
 */

function caseIdForPlanCode(code: RunShellPlanErrorCode): string {
  switch (code) {
    case 'SHELL_DIALECT_MISMATCH': return SHELL_CASE_IDS.dialectMismatch
    case 'SHELL_EXECUTABLE_UNAVAILABLE': return SHELL_CASE_IDS.executableUnavailable
    case 'SHELL_INTERACTIVE_TTY_REQUIRED': return SHELL_CASE_IDS.tuiRequiresTerminal
    case 'SHELL_TUI_UNDETECTABLE': return SHELL_CASE_IDS.tuiUndetectable
    default: return SHELL_CASE_IDS.planInvalid
  }
}

/** D-7：转换点一次构造、模型出口与台账出口共用的结构化诊断。字段名固定，可省略缺失字段但不得改名。 */
export interface ShellPlanRejectionPayload {
  code: RunShellPlanErrorCode
  caseId: string
  detectedSyntax?: string
  expectedDialect?: string
  shellProfileId?: string
  signals?: string[]
  hints?: string[]
}

export interface PlanRejectionContext {
  sessionId?: string
  requestId?: string
  toolUseId?: string
  command?: string
}

export interface PlanRejectionDeps {
  breaker?: DialectRetryBreaker
  log?: typeof logShellAgentEvent
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function commandFingerprint(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

/**
 * D-7/D-8：白名单内的计划错误 → PlanRejectedError（拒绝文本为固定字段名的紧凑单行 JSON、不加围栏）。
 * 同一 payload 对象同时写 shell.exec.plan_failed 台账（§4.3：单次序列化与台账复用）；
 * 方言错配按 session+profile+signals 计数，第 2 次同款把 hints 升级为改写形态（不阻断）。
 * 返回 undefined 表示该错误不在白名单内（调用方保持 fatal）。
 */
export function planRejectionFromRunShellPlan(
  error: RunShellPlanError,
  context: PlanRejectionContext = {},
  deps: PlanRejectionDeps = {}
): PlanRejectedError | undefined {
  if (!RETURNABLE_RUN_SHELL_PLAN_CODES.has(error.code)) return undefined
  const breaker = deps.breaker ?? sharedDialectRetryBreaker
  const log = deps.log ?? logShellAgentEvent
  const details = error.details as {
    detectedSyntax?: unknown
    expectedDialect?: unknown
    shellProfileId?: unknown
    signals?: unknown
    hints?: unknown
  }
  const signals = stringArray(details.signals)
  const shellProfileId = typeof details.shellProfileId === 'string' ? details.shellProfileId : undefined
  const detectedSyntax = typeof details.detectedSyntax === 'string' ? details.detectedSyntax : undefined
  // D-8：计数只对方言错配维护（其他计划码没有「改写即可恢复」的重试语义）
  const retry = error.code === 'SHELL_DIALECT_MISMATCH' && shellProfileId && signals?.length
    ? breaker.record(context.sessionId ?? '', shellProfileId, signals)
    : undefined
  const payload: ShellPlanRejectionPayload = {
    code: error.code,
    caseId: caseIdForPlanCode(error.code),
    ...(detectedSyntax ? { detectedSyntax } : {}),
    ...(typeof details.expectedDialect === 'string' ? { expectedDialect: details.expectedDialect } : {}),
    ...(shellProfileId ? { shellProfileId } : {}),
    ...(signals ? { signals } : {}),
    ...(stringArray(details.hints) ? { hints: stringArray(details.hints) } : {})
  }
  if (retry?.tripped && detectedSyntax) {
    payload.hints = escalatedDialectMismatchHints(detectedSyntax as import('../shell/shellProfiles').ShellDialect)
  }
  // A-2（§4.4）：retryCount/retryExhausted 如实字段化进模型出口（第 2 次仅升级提示，不阻断）
  const modelPayload = retry
    ? { ...payload, retryCount: retry.count, retryExhausted: retry.tripped }
    : payload
  log('error', 'shell.exec.plan_failed', {
    requestId: context.requestId,
    sessionId: context.sessionId,
    toolUseId: context.toolUseId,
    ...(context.command ? { commandFingerprint: commandFingerprint(context.command) } : {}),
    ...(shellProfileId ? { shell: shellProfileId } : {}),
    errorCode: error.code,
    caseId: payload.caseId,
    ...(signals ? { signals } : {}),
    ...(retry ? { retryCount: retry.count, retryExhausted: retry.tripped } : {})
  })
  return new PlanRejectedError(error.code, JSON.stringify(modelPayload))
}

/** 阶段 1 契约保留：不关心计数与台账的调用方使用。 */
export function toPlanRejectedError(error: RunShellPlanError): PlanRejectedError | undefined {
  if (!RETURNABLE_RUN_SHELL_PLAN_CODES.has(error.code)) return undefined
  const details = error.details as Record<string, unknown>
  const payload: ShellPlanRejectionPayload = {
    code: error.code,
    caseId: caseIdForPlanCode(error.code),
    ...(typeof details.detectedSyntax === 'string' ? { detectedSyntax: details.detectedSyntax } : {}),
    ...(typeof details.expectedDialect === 'string' ? { expectedDialect: details.expectedDialect } : {}),
    ...(typeof details.shellProfileId === 'string' ? { shellProfileId: details.shellProfileId } : {}),
    ...(stringArray(details.signals) ? { signals: stringArray(details.signals) } : {}),
    ...(stringArray(details.hints) ? { hints: stringArray(details.hints) } : {})
  }
  return new PlanRejectedError(error.code, JSON.stringify(payload))
}
