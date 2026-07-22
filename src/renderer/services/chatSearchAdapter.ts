import type { RefObject } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Message } from '../../shared/domainTypes'
import type { DisplayMessageEntry } from '../../shared/displayOrder'
import { useSearch } from '../components/Search/SearchProvider'
import { store } from '../store'
import { setScrollToMessageId } from '../store/chatSlice'
import {
  loadSessionSearchCorpus,
  mergeSearchCorpusWithLive
} from './chatSearchCorpus'
import {
  shouldClearSearchCorpus,
  shouldReloadSearchCorpus
} from './chatSearchCorpusLifecycle'
import { useChatStructuredSearchAdapter } from './chatStructuredSearchAdapter'

export function useChatSearchAdapter(
  containerRef: RefObject<HTMLElement | null>,
  args: {
    sessionId: string | null | undefined
    displayEntries: DisplayMessageEntry[]
    messages: Message[]
  }
) {
  const { activePanel, isOpen } = useSearch()
  const active = activePanel === 'chat'
  const [dbCorpus, setDbCorpus] = useState<DisplayMessageEntry[]>([])
  const [corpusSessionId, setCorpusSessionId] = useState<string | null>(null)

  useEffect(() => {
    if (shouldClearSearchCorpus({ active, isOpen, sessionId: args.sessionId })) {
      setDbCorpus([])
      setCorpusSessionId(null)
      return
    }

    if (
      !shouldReloadSearchCorpus({
        active,
        isOpen,
        sessionId: args.sessionId,
        loadedSessionId: corpusSessionId
      })
    ) {
      return
    }

    let cancelled = false
    const sessionId = args.sessionId as string
    void (async () => {
      const corpus = await loadSessionSearchCorpus(sessionId)
      if (cancelled) return
      setDbCorpus(corpus)
      setCorpusSessionId(sessionId)
    })()

    return () => {
      cancelled = true
    }
    // query 故意不在依赖中：语料绑定 sessionId + 面板打开，不随输入重扫
  }, [active, isOpen, args.sessionId, corpusSessionId])

  const liveEntries = useMemo(() => {
    if (args.displayEntries.length > 0) return args.displayEntries
    // fallback：无 displayEntries 时用 messages（测试/过渡）
    return args.messages.map((message, index) => ({
      message,
      order: { kind: 'optimistic' as const, ordinal: index }
    }))
  }, [args.displayEntries, args.messages])

  const entries = useMemo(() => {
    if (corpusSessionId !== args.sessionId || dbCorpus.length === 0) {
      return liveEntries
    }
    return mergeSearchCorpusWithLive(dbCorpus, liveEntries)
  }, [dbCorpus, corpusSessionId, args.sessionId, liveEntries])

  useChatStructuredSearchAdapter({
    containerRef,
    active,
    entries,
    messageCount: entries.length,
    onNavigateToMatch: (messageId) => {
      // 始终走 scrollToMessageId：消息可能在 store 中但 Virtuoso 未挂载
      store.dispatch(setScrollToMessageId(messageId))
    }
  })
}
