export type NormalizedStopReason = 'max_tokens' | 'end_turn' | 'tool_use' | 'other'

export function normalizeStopReason(raw: string | undefined): NormalizedStopReason | undefined {
  if (raw == null || typeof raw !== 'string') return undefined
  const s = raw.trim().toLowerCase()
  if (!s) return undefined

  if (s === 'max_tokens' || s === 'length') return 'max_tokens'
  if (s === 'end_turn' || s === 'stop') return 'end_turn'
  if (s === 'tool_use') return 'tool_use'

  return 'other'
}
