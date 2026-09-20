import { getDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'

/**
 * 工具撤回注册表(A2,偏差 18):状态随实例走,一个进程可多实例并存
 * (经 createAgentRuntime);旧全局函数为兼容转发。
 */

type RequestState = { lane: string; revoked: Set<string> }

export const TOOL_REQUEST_LANES = ['desktop', 'feishu', 'wechat'] as const

export class ToolRevocationRegistry {
  private readonly active = new Map<string, RequestState>()

  registerToolRevocationRequest(requestId: string, lane: string): void {
    this.active.set(requestId, { lane, revoked: new Set() })
  }

  revokeToolForLane(lane: string, toolName: string): number {
    let count = 0
    for (const state of this.active.values()) {
      if (state.lane !== lane) continue
      state.revoked.add(toolName)
      count++
    }
    return count
  }

  revokeToolForAllLanes(toolName: string): number {
    let count = 0
    for (const lane of TOOL_REQUEST_LANES) count += this.revokeToolForLane(lane, toolName)
    return count
  }

  isToolRevoked(requestId: string, toolName: string): boolean {
    return this.active.get(requestId)?.revoked.has(toolName) ?? false
  }

  clearToolRevocationRequest(requestId: string): void {
    this.active.delete(requestId)
  }
}

/** @deprecated 兼容转发(偏差 18,一个发布周期,P8 评估删除):经默认 runtime 实例。 */
export function registerToolRevocationRequest(requestId: string, lane: string): void {
  getDefaultAgentRuntime().toolRevocations.registerToolRevocationRequest(requestId, lane)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function revokeToolForLane(lane: string, toolName: string): number {
  return getDefaultAgentRuntime().toolRevocations.revokeToolForLane(lane, toolName)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function revokeToolForAllLanes(toolName: string): number {
  return getDefaultAgentRuntime().toolRevocations.revokeToolForAllLanes(toolName)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function isToolRevoked(requestId: string, toolName: string): boolean {
  return getDefaultAgentRuntime().toolRevocations.isToolRevoked(requestId, toolName)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function clearToolRevocationRequest(requestId: string): void {
  getDefaultAgentRuntime().toolRevocations.clearToolRevocationRequest(requestId)
}
