import type { Message } from '../../shared/domainTypes'
import type { ChatMessagePage } from '../../shared/displayOrder'

export type DisplayPageCursorState = {
  currentSessionId: string | null
  hasMoreBefore: boolean
  oldestSequence: number | null
  loadingBefore: boolean
  displayGeneration: number
}

/**
 * 始终从最新 store 游标取 beforeSequence，避免 ensureLoaded 循环里闭包陈旧。
 * 返回是否成功发出一次 prepend。
 */
export async function loadPreviousDisplayPage(args: {
  sessionId: string
  getState: () => DisplayPageCursorState
  fetchPage: (payload: {
    sessionId: string
    beforeSequence: number
    limit: number
  }) => Promise<ChatMessagePage>
  setLoading: (loading: boolean) => void
  prepend: (payload: {
    entries: ChatMessagePage['entries']
    oldestSequence: number | null
    hasMoreBefore: boolean
    generation: number
  }) => void
  limit?: number
}): Promise<{ loaded: boolean; beforeSequence: number | null }> {
  const state = args.getState()
  if (
    state.currentSessionId !== args.sessionId ||
    !state.hasMoreBefore ||
    state.loadingBefore ||
    state.oldestSequence == null
  ) {
    return { loaded: false, beforeSequence: null }
  }

  const beforeSequence = state.oldestSequence
  const generation = state.displayGeneration
  args.setLoading(true)
  try {
    const page = await args.fetchPage({
      sessionId: args.sessionId,
      beforeSequence,
      limit: args.limit ?? 60
    })
    if (args.getState().currentSessionId !== args.sessionId) {
      return { loaded: false, beforeSequence }
    }
    args.prepend({
      entries: page.entries,
      oldestSequence: page.oldestSequence,
      hasMoreBefore: page.hasMoreBefore,
      generation
    })
    return { loaded: true, beforeSequence }
  } finally {
    args.setLoading(false)
  }
}

/** 循环 prepend 直到目标消息进入已加载展示集，或没有更早页。 */
export async function ensureDisplayContainsMessage(args: {
  sessionId: string
  messageId: string
  getMessages: () => Message[]
  getState: () => DisplayPageCursorState
  loadPrevious: () => Promise<{ loaded: boolean; beforeSequence: number | null }>
  maxPages?: number
}): Promise<{ found: boolean; beforeSequences: number[] }> {
  const beforeSequences: number[] = []
  const maxPages = args.maxPages ?? 40
  for (let i = 0; i < maxPages; i++) {
    if (args.getMessages().some((m) => m.id === args.messageId)) {
      return { found: true, beforeSequences }
    }
    const state = args.getState()
    if (!state.hasMoreBefore || state.oldestSequence == null || state.loadingBefore) {
      return { found: false, beforeSequences }
    }
    const result = await args.loadPrevious()
    if (result.beforeSequence != null) beforeSequences.push(result.beforeSequence)
    if (!result.loaded) {
      return { found: args.getMessages().some((m) => m.id === args.messageId), beforeSequences }
    }
  }
  return {
    found: args.getMessages().some((m) => m.id === args.messageId),
    beforeSequences
  }
}
