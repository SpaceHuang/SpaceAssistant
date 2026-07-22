import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type ReactElement
} from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { Message } from '../../../shared/domainTypes'

const FIRST_ITEM_INDEX_BASE = 100_000

export type ChatMessageViewportHandle = {
  scrollToMessageId: (messageId: string) => void
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void
}

type Props = {
  messages: Message[]
  stickToBottom: boolean
  onStickToBottomChange: (nearBottom: boolean) => void
  onStartReached?: () => void
  scrollToLatestMounted: boolean
  showScrollToLatest: boolean
  scrollToLatestLabel: string
  scrollToLatestIconHtml: string
  onScrollToLatest: () => void
  renderMessage: (index: number, message: Message) => ReactElement
}

/**
 * Virtuoso 窗口化视口：startReached 加载更早页，followOutput 追随底部，prepend 用 firstItemIndex 锚定。
 */
export const ChatMessageViewport = memo(
  forwardRef<ChatMessageViewportHandle, Props>(function ChatMessageViewport(
    {
      messages,
      stickToBottom,
      onStickToBottomChange,
      onStartReached,
      scrollToLatestMounted,
      showScrollToLatest,
      scrollToLatestLabel,
      scrollToLatestIconHtml,
      onScrollToLatest,
      renderMessage
    },
    ref
  ) {
    const virtuosoRef = useRef<VirtuosoHandle>(null)
    const [firstItemIndex, setFirstItemIndex] = useState(FIRST_ITEM_INDEX_BASE)
    const prevFirstIdRef = useRef<string | null>(null)
    const prevLenRef = useRef(0)
    const stickRef = useRef(stickToBottom)
    stickRef.current = stickToBottom

    useEffect(() => {
      const firstId = messages[0]?.id ?? null
      const len = messages.length
      const prevFirst = prevFirstIdRef.current
      const prevLen = prevLenRef.current

      if (len === 0) {
        setFirstItemIndex(FIRST_ITEM_INDEX_BASE)
      } else if (prevLen === 0) {
        setFirstItemIndex(FIRST_ITEM_INDEX_BASE)
      } else if (firstId && prevFirst && firstId !== prevFirst && len > prevLen) {
        const added = len - prevLen
        setFirstItemIndex((idx) => idx - added)
      }

      prevFirstIdRef.current = firstId
      prevLenRef.current = len
    }, [messages])

    useImperativeHandle(
      ref,
      () => ({
        scrollToMessageId(messageId: string) {
          const index = messages.findIndex((m) => m.id === messageId)
          if (index < 0) return
          virtuosoRef.current?.scrollToIndex({
            index: firstItemIndex + index,
            align: 'center',
            behavior: 'smooth'
          })
        },
        scrollToBottom(behavior = 'auto') {
          if (messages.length === 0) return
          virtuosoRef.current?.scrollToIndex({
            index: firstItemIndex + messages.length - 1,
            align: 'end',
            behavior
          })
        }
      }),
      [messages, firstItemIndex]
    )

    const handleStartReached = useCallback(() => {
      onStartReached?.()
    }, [onStartReached])

    const followOutput = useCallback(() => (stickRef.current ? ('smooth' as const) : false), [])

    const atBottomStateChange = useCallback(
      (atBottom: boolean) => {
        onStickToBottomChange(atBottom)
      },
      [onStickToBottomChange]
    )

    return (
      <div className="chat-scroll-wrap">
        <Virtuoso
          ref={virtuosoRef}
          className="chat-scroll"
          style={{ height: '100%' }}
          data={messages}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={Math.max(0, messages.length - 1)}
          computeItemKey={(_index, message) => message.id}
          itemContent={(index, message) => renderMessage(index - firstItemIndex, message)}
          startReached={handleStartReached}
          followOutput={followOutput}
          atBottomStateChange={atBottomStateChange}
          atBottomThreshold={80}
          increaseViewportBy={{ top: 400, bottom: 400 }}
        />
        {scrollToLatestMounted ? (
          <button
            type="button"
            className={`chat-scroll-to-latest${showScrollToLatest ? '' : ' chat-scroll-to-latest--hidden'}`}
            title={scrollToLatestLabel}
            aria-label={scrollToLatestLabel}
            aria-hidden={!showScrollToLatest}
            tabIndex={showScrollToLatest ? 0 : -1}
            onClick={onScrollToLatest}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onScrollToLatest()
            }}
            dangerouslySetInnerHTML={{ __html: scrollToLatestIconHtml }}
          />
        ) : null}
      </div>
    )
  })
)
