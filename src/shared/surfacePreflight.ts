export type SurfacePreflightInput = { ids: readonly string[]; requiredIds: readonly string[]; currentUserMessageId: string; fingerprint: string; expectedFingerprint: string; estimatedTotalInputTokens: number; totalInputBudget: number; toolUses: readonly string[]; toolResults: readonly string[] }
export type SurfacePreflightResult = { ok: true; tokenCheckSource: 'default_estimator' | 'exact_provider' } | { ok: false; reason: 'required_ids_invalid' | 'current_input_missing' | 'fingerprint_mismatch' | 'tool_pair_invalid' | 'token_budget_exceeded'; tokenCheckSource: 'default_estimator' | 'exact_provider' }

export function validateSurfaceForSend(input: SurfacePreflightInput, tokenCheckSource: SurfacePreflightResult['tokenCheckSource'] = 'default_estimator'): SurfacePreflightResult {
  const counts = new Map<string, number>()
  for (const id of input.ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  if (input.requiredIds.some((id) => counts.get(id) !== 1) || input.ids.length !== new Set(input.ids).size) return { ok: false, reason: 'required_ids_invalid', tokenCheckSource }
  if (counts.get(input.currentUserMessageId) !== 1) return { ok: false, reason: 'current_input_missing', tokenCheckSource }
  if (input.fingerprint !== input.expectedFingerprint) return { ok: false, reason: 'fingerprint_mismatch', tokenCheckSource }
  if (input.toolUses.length !== input.toolResults.length || input.toolUses.some((id, index) => input.toolResults[index] !== id)) return { ok: false, reason: 'tool_pair_invalid', tokenCheckSource }
  if (input.estimatedTotalInputTokens > input.totalInputBudget) return { ok: false, reason: 'token_budget_exceeded', tokenCheckSource }
  return { ok: true, tokenCheckSource }
}
