/** Ignore failures of this derived view so callers can continue to their authoritative source reader. */
export async function prepareChatBodyForRead(
  ensureChatBodyV1: ((input: Readonly<{ sessionId: string; signal?: AbortSignal }>) => Promise<unknown>) | undefined,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await ensureChatBodyV1?.({ sessionId, ...(signal ? { signal } : {}) })
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    if (signal?.aborted || message === 'PROJECTION_VIEW_CANCELLED' || !isProjectionPreparationFailure(message)) throw error
  }
}

function isProjectionPreparationFailure(message: string): boolean {
  return /^(?:PROJECTION_(?:PREPARATION|BUILD|STATE|CACHE)_|SESSION_PROJECTION_PREPARATION_)/.test(message)
}
