import { useRef, type ReactNode } from 'react'
import { ChatSearchDriver } from './searchDrivers'

type Props = {
  messageCount: number
  children: ReactNode
}

/** 搜索驱动与消息列表分离，气泡不因匹配计数更新而重渲染。 */
export function ChatMessageListSearch({ messageCount, children }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <ChatSearchDriver containerRef={containerRef} messageCount={messageCount} />
      <div ref={containerRef} className="chat-message-list">
        {children}
      </div>
    </>
  )
}
