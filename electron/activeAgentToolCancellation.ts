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

/** Cancel every prepared or executing SDK tool call of one (sessionId, turnId); returns the cancelled count. */
export function cancelAllActiveAgentToolsForTurn(sessionId: string, turnId: string): number {
  // 与 keyFor 同源：二元组序列化去掉闭括号、补尾逗号 → `["sid","tid",`，
  // 恰好覆盖该 turn 的全部三元组 key（JSON 转义保证 turnId 里的引号/逗号不会伪造前缀）。
  // 只调 cancel 不直接 delete：登记句柄的注销走其自有清理路径（与 registeredAgentTurnTools
  // 的 cleanupPrepared 一致性守卫同路）。
  const prefix = JSON.stringify([sessionId, turnId]).slice(0, -1) + ','
  let count = 0
  for (const [key, entry] of [...activeCancellations]) {
    if (!key.startsWith(prefix)) continue
    entry.cancel()
    count++
  }
  return count
}
