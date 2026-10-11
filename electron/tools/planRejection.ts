import { PlanRejectedError } from '../../packages/agent-sdk/src/turn'
import { RunShellPlanError, type RunShellPlanErrorCode } from './runShellPlan'
import { SHELL_CASE_IDS } from '../shell/shellCaseIds'

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

export function buildShellPlanRejectionPayload(error: RunShellPlanError): ShellPlanRejectionPayload {
  const details = error.details as {
    detectedSyntax?: unknown
    expectedDialect?: unknown
    shellProfileId?: unknown
    signals?: unknown
    hints?: unknown
  }
  return {
    code: error.code,
    caseId: caseIdForPlanCode(error.code),
    ...(typeof details.detectedSyntax === 'string' ? { detectedSyntax: details.detectedSyntax } : {}),
    ...(typeof details.expectedDialect === 'string' ? { expectedDialect: details.expectedDialect } : {}),
    ...(typeof details.shellProfileId === 'string' ? { shellProfileId: details.shellProfileId } : {}),
    ...(Array.isArray(details.signals)
      ? { signals: details.signals.filter((signal): signal is string => typeof signal === 'string') }
      : {}),
    ...(Array.isArray(details.hints)
      ? { hints: details.hints.filter((hint): hint is string => typeof hint === 'string') }
      : {})
  }
}

/**
 * D-7 定案：载体仍是字符串（不升级 SDK 类型与 History 结构），内容是固定字段名的紧凑单行 JSON、
 * 不加 Markdown 围栏，模型侧可直接 JSON.parse。返回 undefined 表示该错误不在白名单内（保持 fatal）。
 */
export function toPlanRejectedError(error: RunShellPlanError): PlanRejectedError | undefined {
  if (!RETURNABLE_RUN_SHELL_PLAN_CODES.has(error.code)) return undefined
  return new PlanRejectedError(error.code, JSON.stringify(buildShellPlanRejectionPayload(error)))
}
