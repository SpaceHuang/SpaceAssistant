/** 工具循环单次 API 调用的 max_tokens：默认、上下限与归一化（渲染进程与 Electron 主进程共用） */

export const DEFAULT_TOOL_LOOP_MAX_TOKENS = 32768

export const TOOL_LOOP_MAX_TOKENS_MIN = 256

export const TOOL_LOOP_MAX_TOKENS_MAX = 1_000_000

/**
 * 内置工具循环下，单次模型输出若过小，thinking/正文 + tool JSON（尤其 write_file 的 content）
 * 极易在 JSON 未闭合前触发 max_tokens，出现「有 path 无 content」的假写调用。
 */
export const TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN = 16384

export function normalizeToolLoopMaxTokens(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_TOOL_LOOP_MAX_TOKENS
  }
  return Math.min(TOOL_LOOP_MAX_TOKENS_MAX, Math.max(TOOL_LOOP_MAX_TOKENS_MIN, Math.floor(raw)))
}

/** 会话配置的 max_tokens 经归一化后，再为「带内置工具」的请求抬到安全下限 */
export function effectiveMaxTokensForBuiltinToolLoop(raw: unknown): number {
  return Math.max(normalizeToolLoopMaxTokens(raw), TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN)
}
