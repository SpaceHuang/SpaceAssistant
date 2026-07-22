import type { RefObject } from 'react'
import type { Message } from '../../../shared/domainTypes'
import type { DisplayMessageEntry } from '../../../shared/displayOrder'
import { useChatSearchAdapter } from '../../services/chatSearchAdapter'
import { useFileMarkdownSearchAdapter } from '../../services/fileMarkdownSearchAdapter'

/** 仅订阅 SearchContext 的空组件，避免 Markdown / 消息列表随匹配计数重渲染。 */
export function FileMarkdownSearchDriver({
  containerRef
}: {
  containerRef: RefObject<HTMLElement | null>
}) {
  useFileMarkdownSearchAdapter(containerRef)
  return null
}

export function ChatSearchDriver({
  containerRef,
  sessionId,
  messages,
  displayEntries
}: {
  containerRef: RefObject<HTMLElement | null>
  sessionId?: string | null
  messages: Message[]
  displayEntries?: DisplayMessageEntry[]
}) {
  useChatSearchAdapter(containerRef, {
    sessionId,
    messages,
    displayEntries: displayEntries ?? []
  })
  return null
}
