import type { RefObject } from 'react'
import { useSearch } from '../components/Search/SearchProvider'
import { useDomSearchAdapter } from './domSearchAdapter'

export function useChatSearchAdapter(
  containerRef: RefObject<HTMLElement | null>,
  messageCount: number
) {
  const { activePanel } = useSearch()
  const active = activePanel === 'chat'

  useDomSearchAdapter({
    containerRef,
    active,
    blockSelector: '.chat-bubble',
    messageCount
  })
}
