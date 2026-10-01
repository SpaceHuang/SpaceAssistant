import type { AdmissionTicket, CallAdmissionGate } from './callAdmissionGate'

type AdmissionPort = {
  park(checkpoint?: unknown): unknown
  discard?(handle: unknown): void
  resume(handle: unknown, options?: { signal?: AbortSignal }): { ok: true } | { ok: false; retryable: boolean; cause?: string } | Promise<{ ok: true } | { ok: false; retryable: boolean; cause?: string }>
}

/** 将一轮对话的准入票据适配到 Hosted 审批生命周期。暂停持久化失败时保留运行名额，继续审批。 */
export function createApplicationAdmissionPort(
  gate: Pick<CallAdmissionGate, 'park' | 'resume' | 'discard' | 'isActiveTicket'>,
  initialTicket: AdmissionTicket,
  onParkFailure?: () => void
): { port: AdmissionPort; release(): void } {
  let activeTicket: AdmissionTicket | undefined = initialTicket
  const heldHandles = new WeakSet<object>()

  const port: AdmissionPort = {
    park(checkpoint?: unknown) {
      if (!activeTicket) return undefined
      const parked = gate.park(activeTicket)
      if (parked) {
        activeTicket = undefined
        return { ...parked, checkpoint }
      }
      if (!gate.isActiveTicket(activeTicket)) return undefined

      onParkFailure?.()
      const heldHandle = { kind: 'held-admission', checkpoint }
      heldHandles.add(heldHandle)
      return heldHandle
    },
    discard(handle) {
      if (!handle || (typeof handle === 'object' && heldHandles.has(handle))) return
      gate.discard(handle as never)
    },
    async resume(handle, options) {
      if (handle && typeof handle === 'object' && heldHandles.has(handle)) return { ok: true }
      if (!handle || activeTicket) return { ok: false, retryable: false, cause: 'invalid-park-handle' }
      const resumed = await gate.resume(handle as never, options)
      if (!resumed.ok) return { ok: false, retryable: resumed.retryable, cause: resumed.cause }
      activeTicket = resumed.ticket
      return { ok: true }
    }
  }

  return {
    port,
    release() {
      activeTicket?.release()
      activeTicket = undefined
    }
  }
}
