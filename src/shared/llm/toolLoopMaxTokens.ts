/** 工具循环单次 API 调用的 max_tokens：默认、上下限与归一化（渲染进程与 Electron 主进程共用） */

export const DEFAULT_TOOL_LOOP_MAX_TOKENS = 32768

export const TOOL_LOOP_MAX_TOKENS_MIN = 256

export const TOOL_LOOP_MAX_TOKENS_MAX = 1_000_000

export function normalizeToolLoopMaxTokens(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_TOOL_LOOP_MAX_TOKENS
  }
  return Math.min(TOOL_LOOP_MAX_TOKENS_MAX, Math.max(TOOL_LOOP_MAX_TOKENS_MIN, Math.floor(raw)))
}
