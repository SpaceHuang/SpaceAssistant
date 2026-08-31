import type { ConfirmRequest } from '../../src/shared/confirmation/types'
import type { ImChannel, ImPendingConfirm } from './imChannel'
import type { RemoteConfirmDecision, RemoteConfirmPayload } from '../tools/types'

/**
 * §5.4 桥接工厂：用 `ImChannel` 产出主循环使用的 `requestToolConfirm`（替代
 * remoteConfirmBridge 的两个对称工厂）。`buildConfirmRequest`/`buildPending` 由调用方按链路注入
 * （含 prompt/facts 构建），ImChannel 负责注册、入站解析、桌面代答、超时与 confirm.* 审计。
 */
export function createImRequestToolConfirm(args: {
  imChannel: ImChannel
  buildConfirmRequest: (payload: RemoteConfirmPayload) => ConfirmRequest
  buildPending: (
    payload: RemoteConfirmPayload,
    req: ConfirmRequest
  ) => Omit<ImPendingConfirm, 'id' | 'confirmId' | 'createdAt' | 'expiresAt' | 'channel' | 'memoryTiers'> & {
    memoryTiers?: ImPendingConfirm['memoryTiers']
  }
}): (payload: RemoteConfirmPayload) => Promise<RemoteConfirmDecision> {
  return async (payload) => {
    const req = args.buildConfirmRequest(payload)
    const pending = args.buildPending(payload, req)
    const outcome = await args.imChannel.request(req, pending)
    if (outcome.kind === 'approved') return 'y'
    if (outcome.kind === 'timeout') return 'timeout'
    return 'n'
  }
}
