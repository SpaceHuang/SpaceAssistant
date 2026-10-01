type ActiveCancellation = Readonly<{ cancel: () => void }>

const activeCancellations = new Map<string, ActiveCancellation>()

function keyFor(sessionId: string, turnId: string, toolUseId: string): string {
  return JSON.stringify([sessionId, turnId, toolUseId])
}

/** Register the SDK dispatch-lease cancellation for one exact session turn and tool call. */
export function registerActiveAgentToolCancellation(
  sessionId: string,
  turnId: string,
  toolUseId: string,
  cancel: () => void
): () => void {
  const key = keyFor(sessionId, turnId, toolUseId)
  const entry = { cancel }
  activeCancellations.set(key, entry)
  return () => {
    if (activeCancellations.get(key) === entry) activeCancellations.delete(key)
  }
}

/** Cancel only the prepared or executing SDK tool call that owns this complete identity. */
export function cancelActiveAgentTool(sessionId: string, turnId: string, toolUseId: string): boolean {
  const entry = activeCancellations.get(keyFor(sessionId, turnId, toolUseId))
  if (!entry) return false
  entry.cancel()
  return true
}
