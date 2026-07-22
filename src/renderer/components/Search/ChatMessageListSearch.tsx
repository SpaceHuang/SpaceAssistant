import { useRef, type ReactNode } from 'react'
import type { Message } from '../../../shared/domainTypes'
import type { DisplayMessageEntry } from '../../../shared/displayOrder'
import { ChatSearchDriver } from './searchDrivers'

type Props = {
  sessionId?: string | null
  messages: Message[]
  displayEntries?: DisplayMessageEntry[]
  children: ReactNode
}

/** 搜索驱动与消息列表分离，气泡不因匹配计数更新而重渲染。 */
export function ChatMessageListSearch({
  sessionId,
  messages,
  displayEntries,
  children
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <ChatSearchDriver
        containerRef={containerRef}
        sessionId={sessionId}
        messages={messages}
        displayEntries={displayEntries}
      />
      <div
        ref={containerRef}
        className="chat-message-list"
        style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        {children}
      </div>
    </>
  )
}
