export type SwitchBlocker = 'pending_confirm' | 'tool_in_flight' | 'llm_in_flight'

type RequestSessionState = {
  llm: number
  tool: number
  nonSwitchTool: boolean
}

const stateBySessionRequest = new Map<string, RequestSessionState>()

function stateKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`
}

function getOrCreate(sessionId: string, requestId: string): RequestSessionState {
  const key = stateKey(sessionId, requestId)
  let entry = stateBySessionRequest.get(key)
  if (!entry) {
    entry = { llm: 0, tool: 0, nonSwitchTool: false }
    stateBySessionRequest.set(key, entry)
  }
  return entry
}

export function beginLlm(sessionId: string, requestId: string): void {
  getOrCreate(sessionId, requestId).llm++
}

export function endLlm(sessionId: string, requestId: string): void {
  const entry = stateBySessionRequest.get(stateKey(sessionId, requestId))
  if (entry && entry.llm > 0) entry.llm--
}

export function beginTool(sessionId: string, requestId: string, toolName: string): void {
  const entry = getOrCreate(sessionId, requestId)
  entry.tool++
  if (toolName !== 'switch_session') {
    entry.nonSwitchTool = true
  }
}

export function endTool(sessionId: string, requestId: string, _toolName: string): void {
  const entry = stateBySessionRequest.get(stateKey(sessionId, requestId))
  if (entry && entry.tool > 0) entry.tool--
}

export function clearRequest(requestId: string): void {
  const suffix = `\0${requestId}`
  for (const key of [...stateBySessionRequest.keys()]) {
    if (key.endsWith(suffix)) stateBySessionRequest.delete(key)
  }
}

export function getSessionSwitchBlockers(
  sessionId: string,
  opts?: {
    exemptRequestId?: string
    hasPendingConfirm?: (sessionId: string) => boolean
  }
): SwitchBlocker[] {
  const blockers: SwitchBlocker[] = []
  if (opts?.hasPendingConfirm?.(sessionId)) {
    blockers.push('pending_confirm')
  }

  let toolTotal = 0
  let llmBlocked = 0
  const prefix = `${sessionId}\0`

  for (const [key, entry] of stateBySessionRequest) {
    if (!key.startsWith(prefix)) continue
    const reqId = key.slice(prefix.length)
    toolTotal += entry.tool
    if (entry.llm > 0) {
      const exempt =
        opts?.exemptRequestId !== undefined &&
        opts.exemptRequestId === reqId &&
        !entry.nonSwitchTool
      if (!exempt) llmBlocked += entry.llm
    }
  }

  if (toolTotal > 0) blockers.push('tool_in_flight')
  if (llmBlocked > 0) blockers.push('llm_in_flight')
  return blockers
}

/** Test-only: reset in-memory switch state. */
export function resetRemoteSessionSwitchStateForTests(): void {
  stateBySessionRequest.clear()
}
