/** Ignore failures of this derived view so callers can continue to their authoritative source reader. */
export type PreparedChatBodyReadPreparation = Readonly<{
  ensureChatBodyV1?: (input: Readonly<{ sessionId: string; signal?: AbortSignal }>) => Promise<unknown>
  readPreparedChatBodyV1?: (input: Readonly<{ sessionId: string }>) => unknown
  canReadChatBodyBeforePreparation?: (sessionId: string) => boolean
  requestChatBodyV1?: (input: Readonly<{ sessionId: string }>) => Promise<void>
  readChatMessagesBeforePreparation?: (input: Readonly<{ sessionId: string; limit?: number; offset?: number }>) => unknown[] | undefined
}>

/** Use a current prepared view, or serve the still-valid old owner while scheduling a cold view. */
export function tryPreparedChatBodyForRead(storage: PreparedChatBodyReadPreparation, sessionId: string):
  Readonly<{ handled: boolean; prepared?: unknown }> {
  const prepared = storage.readPreparedChatBodyV1?.({ sessionId })
  if (prepared !== undefined) return { handled: true, prepared }
  if (!storage.requestChatBodyV1 || !storage.canReadChatBodyBeforePreparation?.(sessionId)) return { handled: false }
  void storage.requestChatBodyV1({ sessionId }).catch(() => undefined)
  return { handled: true }
}

export async function prepareChatBodyForRead(
  ensureChatBodyV1: ((input: Readonly<{ sessionId: string; signal?: AbortSignal }>) => Promise<unknown>) | undefined,
  sessionId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await ensureChatBodyV1?.({ sessionId, ...(signal ? { signal } : {}) })
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    if (signal?.aborted || message === 'PROJECTION_VIEW_CANCELLED' || !isProjectionPreparationFailure(message)) throw error
    return undefined
  }
}

function isProjectionPreparationFailure(message: string): boolean {
  return /^(?:PROJECTION_(?:PREPARATION|BUILD|STATE|CACHE)_|SESSION_PROJECTION_PREPARATION_)/.test(message)
}
