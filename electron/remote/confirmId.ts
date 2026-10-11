import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { ConfirmIdSpace as AgentSdkConfirmIdSpace, type ConfirmCodeLease } from '../../packages/agent-sdk/src/runtime/components'

/**
 * 活动同步确认码空间(A2,偏差 18):状态随 ConfirmIdSpace 实例走,
 * 一个进程可多实例并存(经 createAgentRuntime);旧全局函数为兼容转发。
 */

export class ConfirmIdSpace extends AgentSdkConfirmIdSpace {}

/** @deprecated 兼容转发(偏差 18,一个发布周期,P8 评估删除):经默认 runtime 的 confirmIds 实例。 */
export function allocateConfirmId(): ConfirmCodeLease {
  return getDefaultAgentRuntime().confirmIds.allocate()
}

/** @deprecated 兼容转发(偏差 18)。 */
export function releaseConfirmId(lease: ConfirmCodeLease): void {
  getDefaultAgentRuntime().confirmIds.release(lease)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function clearConfirmIdSpace(): void {
  getDefaultAgentRuntime().confirmIds.clear()
}

/** @deprecated 兼容转发(偏差 18)。 */
export function isConfirmIdInUse(id: string): boolean {
  return getDefaultAgentRuntime().confirmIds.isInUse(id)
}
