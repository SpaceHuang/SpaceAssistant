/**
 * R3：MCP 工具审批载荷的入参摘要提取（截断 + 脱敏）。
 *
 * 提取来源是门控入参 toolInput（执行器与门控拿到同一份），零新增读取。
 * O5 定案：大字段（content/code/body 等本次调用新产生、审批别处查不到）保留原值，
 * 兜底上限仅防极端值；判断核心字段（url/path/command）原值；密钥类只留键名不留值。
 */
import type { FactSignal } from '../../../src/shared/confirmation/types'
import { sanitizeAgentText } from '../../../src/shared/agentSafeText'

/** argNames 上限（超限置 argsTruncated） */
export const MCP_ARG_NAMES_LIMIT = 20
/** argsDigest 兜底上限（仅防极端值，O5） */
export const MCP_ARGS_DIGEST_LIMIT = 8192

/** secret 类键：只留键名不留值（摘要经 sanitizeAgentText 之外的第二道显式脱敏） */
const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|credential)/i

export interface McpArgsSummary {
  argNames: string[]
  argsDigest: string
  argsTruncated: boolean
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_RE.test(key)) return '[REDACTED]'
  return redactDeep(value)
}

/**
 * E1（评审 2026-09-28）：递归脱敏——嵌套对象/数组（headers.Authorization、auth.token、
 * apiKeys[] 等）与顶层键同规则：键名命中 secret 正则即整值替换；未命中的普通结构逐层下探。
 * 循环引用防护：深度限界（MCP 入参超 8 层视为异常形态，剩余部分整体替换为占位）。
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]'
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v)
    }
    return out
  }
  return value
}

export function summarizeMcpArgs(toolInput: Record<string, unknown>): McpArgsSummary {
  const allKeys = Object.keys(toolInput)
  const argsTruncatedByNames = allKeys.length > MCP_ARG_NAMES_LIMIT
  const argNames = allKeys.slice(0, MCP_ARG_NAMES_LIMIT)

  const redacted: Record<string, unknown> = {}
  for (const key of argNames) {
    redacted[key] = redactValue(key, toolInput[key])
  }
  let digest = JSON.stringify(redacted)
  let argsTruncated = argsTruncatedByNames
  if (digest.length > MCP_ARGS_DIGEST_LIMIT) {
    digest = `${digest.slice(0, MCP_ARGS_DIGEST_LIMIT)}…[truncated]`
    argsTruncated = true
  }
  return {
    argNames,
    argsDigest: sanitizeAgentText(digest).text,
    argsTruncated
  }
}

/** O5（§4.3.2）：无注解时的 schema 启发式——method=GET（或声明为只读集合）视为「无副作用声明可辨」。 */
function isSchemaHeuristicRead(toolInput: Record<string, unknown>): boolean {
  return toolInput.method === 'GET'
}

/**
 * 构造 mcp-invocation 事实信号（与 mcp-tool / mcp-readonly 并存，不改既有规则匹配）。
 * actionClass 由调用方传入（维持既有判定：annotationsSafe → read，否则 write）——本函数
 * 只负责「标注依据」，不改变读写分类（需求 §R3「整体松紧不变」）。
 */
export function extractMcpInvocationSignal(input: {
  serverId: string
  toolName: string
  toolInput: Record<string, unknown>
  annotationsSafe: boolean
  actionClass?: 'read' | 'write'
  inputSchema: Record<string, unknown>
}): FactSignal {
  const actionClass: 'read' | 'write' =
    input.actionClass ?? (input.annotationsSafe ? 'read' : 'write')
  const classificationBasis: 'annotations-readonly' | 'schema-heuristic' | 'default-write' =
    input.annotationsSafe
      ? 'annotations-readonly'
      : isSchemaHeuristicRead(input.toolInput)
        ? 'schema-heuristic'
        : 'default-write'
  const targetUrl =
    typeof input.toolInput.url === 'string' && input.toolInput.url
      ? sanitizeAgentText(input.toolInput.url).text
      : undefined
  const targetPath =
    typeof input.toolInput.path === 'string' && input.toolInput.path
      ? sanitizeAgentText(input.toolInput.path).text
      : undefined
  const method = typeof input.toolInput.method === 'string' ? input.toolInput.method : undefined
  const summary = summarizeMcpArgs(input.toolInput)
  return {
    kind: 'mcp-invocation',
    serverId: input.serverId,
    toolName: input.toolName,
    actionClass,
    ...(targetUrl ? { targetUrl } : {}),
    ...(targetPath ? { targetPath } : {}),
    ...(method ? { method } : {}),
    argNames: summary.argNames,
    argsDigest: summary.argsDigest,
    argsTruncated: summary.argsTruncated,
    classificationBasis
  }
}
