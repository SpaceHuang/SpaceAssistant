export type ToolDurationPhases = { waitingMs?: number; executionMs?: number; totalMs?: number }

export function getToolDurationPhases(args: {
  startedAt?: number
  confirmedAt?: number
  completedAt?: number
  now?: number
}): ToolDurationPhases {
  const { startedAt, confirmedAt, completedAt, now = Date.now() } = args
  if (startedAt === undefined) return {}
  const end = completedAt ?? now
  const confirmation = confirmedAt ?? startedAt
  return {
    waitingMs: confirmedAt === undefined ? undefined : Math.max(0, confirmation - startedAt),
    executionMs: Math.max(0, end - confirmation),
    totalMs: Math.max(0, end - startedAt)
  }
}
