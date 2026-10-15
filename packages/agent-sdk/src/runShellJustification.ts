/** Per-call run_shell intent normalization shared by every host using the Agent SDK. */
export const RUN_SHELL_JUSTIFICATION_MAX_CODE_POINTS = 2_000

export function normalizeRunShellJustification(input: Record<string, unknown>): Record<string, unknown> {
  const { _justificationTruncated: _untrustedTruncationMarker, ...untrustedInput } = input
  if (typeof input.justification !== 'string') return untrustedInput
  const normalized = input.justification.normalize('NFC').trim()
  if (!normalized) {
    const { justification: _ignored, ...rest } = untrustedInput
    return rest
  }
  const points = Array.from(normalized)
  const truncated = points.length > RUN_SHELL_JUSTIFICATION_MAX_CODE_POINTS
  const result: Record<string, unknown> = {
    ...untrustedInput,
    justification: truncated ? points.slice(0, RUN_SHELL_JUSTIFICATION_MAX_CODE_POINTS).join('') : normalized
  }
  if (truncated) result._justificationTruncated = true
  else delete result._justificationTruncated
  return result
}
