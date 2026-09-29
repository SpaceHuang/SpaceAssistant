/**
 * R3：工具声明「审批可见输入」的必需字段（§5.2 前半区：工具契约）。
 *
 * 声明来源：内置工具走既有 descriptor；MCP 工具由 server 的 inputSchema.required 推导（可用时）。
 * 「声明为空（无安全相关性）」必须与「忘了声明」可区分：decl === undefined 表示未声明。
 */

export interface ApprovalVisibleInputDecl {
  required: string[]
  optional?: string[]
}

/** 由 MCP inputSchema 推导声明；无 required 数组（或 schema 缺失）→ undefined（未声明）。 */
export function approvalPayloadDeclForMcp(
  inputSchema: Record<string, unknown> | undefined
): ApprovalVisibleInputDecl | undefined {
  if (!inputSchema || typeof inputSchema !== 'object') return undefined
  const required = inputSchema.required
  if (!Array.isArray(required)) return undefined
  return {
    required: required.filter((x): x is string => typeof x === 'string')
  }
}

export type ApprovalPayloadCheckResult =
  | { ok: true; declared: boolean }
  | { ok: false; missing: string[]; declared: boolean }

/**
 * 载荷完整性校验。
 * - decl undefined（未声明）→ 不误报（ok + declared:false）——与「声明为空」可区分；
 * - decl.required 为空清单 = 声明「本工具无安全相关性」→ ok + declared:true。
 */
export function assertApprovalPayloadComplete(
  decl: ApprovalVisibleInputDecl | undefined,
  toolInput: Record<string, unknown>
): ApprovalPayloadCheckResult {
  if (decl === undefined) return { ok: true, declared: false }
  const missing = decl.required.filter((field) => {
    const v = toolInput[field]
    return v === undefined || v === null || (typeof v === 'string' && v === '')
  })
  if (missing.length > 0) return { ok: false, missing, declared: true }
  return { ok: true, declared: true }
}
