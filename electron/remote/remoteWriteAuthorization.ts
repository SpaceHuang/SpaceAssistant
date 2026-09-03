import { isRequestLeaseOwner } from './remoteAgentRegistry'
import { remoteAuthorizationRegistry } from './remoteAuthorizationRegistry'
import type { RemoteContext } from '../tools/types'

export interface RemoteWriteRecheckResult {
  ok: boolean
  currentGeneration: number
  leaseOk: boolean
  hasAuthOwner: boolean
}

/**
 * 远程写授权复核（硬不变量，B3）：IM 确认回答回来之后、以及 remote-write 记忆缓存命中时，
 * 都必须在执行前同步复核 owner / 请求租约 / 授权代际，确保撤销、换绑、登出立即生效——
 * 缓存命中不得绕过撤销（等价旧 RemoteWriteGrant 的 generation 校验语义）。
 *
 * 调用方需在同一同步段内消费结果（中间不得有 await，防 TOCTOU）。
 */
export function recheckRemoteWriteAuthorization(
  remoteContext: RemoteContext,
  sessionId: string
): RemoteWriteRecheckResult {
  const originSessionId = remoteContext.originSessionId ?? sessionId
  const authOwner = remoteContext.authOwner ?? remoteContext.userId ?? ''
  const currentGeneration = remoteAuthorizationRegistry.getGeneration(remoteContext.source)
  const leaseOk =
    Boolean(remoteContext.requestId) && isRequestLeaseOwner(originSessionId, remoteContext.requestId!)
  const hasAuthOwner = Boolean(authOwner)
  const generationOk =
    remoteContext.authorizationGeneration == null ||
    remoteContext.authorizationGeneration === currentGeneration
  return { ok: hasAuthOwner && leaseOk && generationOk, currentGeneration, leaseOk, hasAuthOwner }
}
