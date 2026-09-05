type RequestState = { lane: string; revoked: Set<string> }

export const TOOL_REQUEST_LANES = ['desktop', 'feishu', 'wechat'] as const

const active = new Map<string, RequestState>()

export function registerToolRevocationRequest(requestId: string, lane: string): void {
  active.set(requestId, { lane, revoked: new Set() })
}

export function revokeToolForLane(lane: string, toolName: string): number {
  let count = 0
  for (const state of active.values()) {
    if (state.lane !== lane) continue
    state.revoked.add(toolName)
    count++
  }
  return count
}

export function revokeToolForAllLanes(toolName: string): number {
  let count = 0
  for (const lane of TOOL_REQUEST_LANES) count += revokeToolForLane(lane, toolName)
  return count
}

export function isToolRevoked(requestId: string, toolName: string): boolean {
  return active.get(requestId)?.revoked.has(toolName) ?? false
}

export function clearToolRevocationRequest(requestId: string): void {
  active.delete(requestId)
}
