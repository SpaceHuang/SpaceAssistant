export type GrepExecArgs = {
  glob?: string
  outputMode: string
  ignoreCase: boolean
  showLineNumber: boolean
  context?: number
  multiline: boolean
  headLimit: number
  timeoutSeconds?: number
  includeIgnored: boolean
}

export type GrepNormalizeResult =
  | { ok: true; args: GrepExecArgs; effectful: string[] }
  | {
      ok: false
      error: { code: 'param-conflict'; field: string; mode: string; allowed: string; suggestedWrite: string }
    }

const GREP_MODES = ['files_with_matches', 'content', 'count'] as const

/** R7：校验层、候选范围和执行层共同使用生效值归一结果。 */
export function normalizeGrepArgs(input: Record<string, unknown>): GrepNormalizeResult {
  const outputMode = (typeof input.output_mode === 'string' ? input.output_mode : 'files_with_matches') as
    | (typeof GREP_MODES)[number]
    | string
  if (!GREP_MODES.includes(outputMode as (typeof GREP_MODES)[number])) {
    return { ok: false, error: { code: 'param-conflict', field: 'output_mode', mode: String(outputMode),
      allowed: 'files_with_matches | content | count', suggestedWrite: '去掉 output_mode 或改用 files_with_matches / content / count 之一' } }
  }
  const contextRaw = typeof input.context === 'number' ? input.context : undefined
  if (contextRaw !== undefined && (!Number.isInteger(contextRaw) || contextRaw < 0 || contextRaw > 1000)) {
    return { ok: false, error: { code: 'param-conflict', field: 'context', mode: outputMode, allowed: '0～1000 的整数',
      suggestedWrite: '去掉 context 或改为 0～1000 的整数' } }
  }
  const headLimit = typeof input.head_limit === 'number' ? input.head_limit : 100
  if (!Number.isInteger(headLimit) || headLimit < 0 || headLimit > 1_000_000) {
    return { ok: false, error: { code: 'param-conflict', field: 'head_limit', mode: outputMode, allowed: '0～1000000 的整数',
      suggestedWrite: '去掉 head_limit 或改为 0～1000000 的整数' } }
  }
  const timeoutMin = 5
  const timeoutMax = 600
  let timeoutSeconds: number | undefined
  if (input.timeout !== undefined) {
    if (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0) {
      return { ok: false, error: { code: 'param-conflict', field: 'timeout', mode: outputMode, allowed: '5～600 的数字（秒）',
        suggestedWrite: '去掉 timeout 或改为 5～600 的数字' } }
    }
    timeoutSeconds = Math.min(timeoutMax, Math.max(timeoutMin, input.timeout))
  }
  const effectful: string[] = []
  if (contextRaw !== undefined && contextRaw > 0) effectful.push(`context=${contextRaw}`)
  if (input.multiline === true) effectful.push('multiline=true')
  if (outputMode !== 'content' && effectful.length > 0) {
    return { ok: false, error: { code: 'param-conflict', field: effectful[0]!, mode: outputMode,
      allowed: '仅 output_mode=content 下生效', suggestedWrite: `改用 output_mode=content，或去掉 ${effectful.join(' / ')}` } }
  }
  return { ok: true, effectful, args: {
    glob: typeof input.glob === 'string' ? input.glob : undefined,
    outputMode,
    ignoreCase: Boolean(input.ignore_case),
    showLineNumber: outputMode === 'content' && input.show_line_number !== false,
    context: outputMode === 'content' ? contextRaw : undefined,
    multiline: outputMode === 'content' && Boolean(input.multiline),
    headLimit,
    timeoutSeconds,
    includeIgnored: Boolean(input.include_ignored)
  } }
}

export function validateGrepInput(input: Record<string, unknown>): string | null {
  const result = normalizeGrepArgs(input)
  if (result.ok) return null
  const { field, mode, allowed, suggestedWrite } = result.error
  return `grep.paramConflict(${field};${mode};${allowed};${suggestedWrite})`
}
