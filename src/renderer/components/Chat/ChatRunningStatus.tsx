import { memo, useEffect, useMemo, useState } from 'react'
import type { Message } from '../../../shared/domainTypes'
import {
  formatStreamingElapsed,
  resolveStreamingActivityStatus
} from '../../../shared/streamingActivityStatus'
import { formatToolLabel } from './toolCallDisplay'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type ElapsedProps = {
  streamingAssistant: Message
}

/**
 * 仅刷新输入区耗时文案的叶子计时器，避免 MessageInput 主体随秒级时钟重渲染。
 */
export const ChatRunningElapsed = memo(function ChatRunningElapsed({
  streamingAssistant
}: ElapsedProps) {
  const { t } = useTypedTranslation('chat')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streamingAssistant.id])

  const showElapsed = useMemo(() => {
    const activity = resolveStreamingActivityStatus({
      message: streamingAssistant,
      formatToolLabel: (toolName, input) => formatToolLabel(toolName, input, t),
      t,
      now
    })
    return Boolean(activity?.showElapsed)
  }, [streamingAssistant, t, now])

  if (!showElapsed) return null
  return <span className="composer-status__elapsed">{formatStreamingElapsed(now - streamingAssistant.timestamp)}</span>
})

type StatusProps = {
  streamingAssistant: Message | undefined
}

/** 无秒级时钟：仅在 streaming 消息引用变化时更新状态文案。 */
export function resolveChatRunningLabels(
  streamingAssistant: Message | undefined,
  t: ReturnType<typeof useTypedTranslation<'chat'>>['t']
): { label?: string; detail?: string } {
  if (!streamingAssistant) return {}
  const activity = resolveStreamingActivityStatus({
    message: streamingAssistant,
    formatToolLabel: (toolName, input) => formatToolLabel(toolName, input, t),
    t,
    now: Date.now()
  })
  return { label: activity?.label, detail: activity?.detail }
}
