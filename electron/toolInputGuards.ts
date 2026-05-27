/**
 * 工具入参轻量校验（对齐需求 §11 / §15 D-04），避免异常大 payload 或明显畸形输入进入执行器。
 */

const PATH_OR_GLOB_MAX = 8192
const STRING_FIELD_MAX = 8192
/** 与 read_file 截断上限一致，单字段不应超过该量级 */
const TOOL_LARGE_TEXT_MAX = 2 * 1024 * 1024
const RUN_SCRIPT_CODE_MAX = 512 * 1024
const RUN_SCRIPT_TIMEOUT_MAX_SEC = 86_400

function assertNoNul(s: string, field: string): void {
  if (s.includes('\0')) throw new Error(`工具参数无效：${field} 含空字节`)
}

function assertStringLen(s: string, field: string, max: number): void {
  assertNoNul(s, field)
  if (s.length > max) throw new Error(`工具参数无效：${field} 过长（>${max}）`)
}

function optStringLen(v: unknown, field: string, max: number): void {
  if (v === undefined || v === null) return
  if (typeof v !== 'string') throw new Error(`工具参数无效：${field} 须为字符串`)
  assertStringLen(v, field, max)
}

function reqStringLen(v: unknown, field: string, max: number): void {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`工具参数无效：缺少必填参数 ${field}`)
  }
  assertStringLen(v, field, max)
}

/** 与 assertSafeToolInput / 执行器前置校验保持一致 */
export function toolErrMissingPath(toolName: string): string {
  return `工具参数无效：${toolName} 缺少必填参数 path`
}

export function assertSafeToolInput(toolName: string, input: Record<string, unknown>): void {
  switch (toolName) {
    case 'read_file':
      optStringLen(input.path, 'path', PATH_OR_GLOB_MAX)
      return
    case 'list_directory':
      optStringLen(input.path, 'path', PATH_OR_GLOB_MAX)
      return
    case 'grep': {
      const pattern = input.pattern
      if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('工具参数无效：grep 缺少 pattern')
      assertStringLen(pattern, 'pattern', STRING_FIELD_MAX)
      optStringLen(input.path, 'path', PATH_OR_GLOB_MAX)
      optStringLen(input.glob, 'glob', PATH_OR_GLOB_MAX)
      const hl = input.head_limit
      if (hl !== undefined && hl !== null) {
        if (typeof hl !== 'number' || !Number.isFinite(hl) || hl < 0 || hl > 1_000_000) {
          throw new Error('工具参数无效：head_limit 须为 0～1000000 的数字')
        }
      }
      return
    }
    case 'run_script': {
      const code = input.code
      if (typeof code !== 'string') throw new Error('工具参数无效：run_script 缺少 code')
      assertStringLen(code, 'code', RUN_SCRIPT_CODE_MAX)
      const to = input.timeout
      if (to !== undefined && to !== null) {
        if (typeof to !== 'number' || !Number.isFinite(to) || to < 1 || to > RUN_SCRIPT_TIMEOUT_MAX_SEC) {
          throw new Error(`工具参数无效：timeout 须为 1～${RUN_SCRIPT_TIMEOUT_MAX_SEC} 的数字（秒）`)
        }
      }
      return
    }
    case 'edit_file': {
      reqStringLen(input.path, 'path', PATH_OR_GLOB_MAX)
      const oldS = input.old_string
      const newS = input.new_string
      if (typeof oldS !== 'string' || typeof newS !== 'string') throw new Error('工具参数无效：edit_file 需要 old_string 与 new_string')
      assertStringLen(oldS, 'old_string', TOOL_LARGE_TEXT_MAX)
      assertStringLen(newS, 'new_string', TOOL_LARGE_TEXT_MAX)
      return
    }
    case 'write_file': {
      reqStringLen(input.path, 'path', PATH_OR_GLOB_MAX)
      const content = input.content
      if (typeof content !== 'string') throw new Error('工具参数无效：write_file 需要 content')
      assertStringLen(content, 'content', TOOL_LARGE_TEXT_MAX)
      return
    }
    default:
      return
  }
}
