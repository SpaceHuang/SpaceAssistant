import { getDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import {
  TOOL_REQUEST_LANES,
  ToolRevocationRegistry as AgentSdkToolRevocationRegistry,
  type ToolRevocationEvent
} from '../packages/agent-sdk/src/runtime/components'

/**
 * Electron compatibility name for the Agent SDK registry. Request state and synchronous
 * revocation notifications have a single implementation in the SDK runtime component.
 */
export { TOOL_REQUEST_LANES }
export type { ToolRevocationEvent }
export class ToolRevocationRegistry extends AgentSdkToolRevocationRegistry {}

/** @deprecated 兼容转发(偏差 18,一个发布周期,P8 评估删除):经默认 runtime 实例。 */
export function registerToolRevocationRequest(requestId: string, lane: string, executionId: string): void {
  getDefaultAgentRuntime().toolRevocations.registerToolRevocationRequest(requestId, lane, executionId)
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
export function isToolRevoked(requestId: string, toolName: string, executionId?: string): boolean {
  return getDefaultAgentRuntime().toolRevocations.isToolRevoked(requestId, toolName, executionId)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function clearToolRevocationRequest(requestId: string, executionId?: string): void {
  getDefaultAgentRuntime().toolRevocations.clearToolRevocationRequest(requestId, executionId)
}
