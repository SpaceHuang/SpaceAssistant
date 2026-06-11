import type { RefObject } from 'react'
import { useSearch } from '../components/Search/SearchProvider'
import { useDomSearchAdapter } from './domSearchAdapter'

export function useFileMarkdownSearchAdapter(containerRef: RefObject<HTMLElement | null>) {
  const { activePanel } = useSearch()
  const active = activePanel === 'file-markdown'

  useDomSearchAdapter({
    containerRef,
    active,
    watchMutations: false
  })
}
