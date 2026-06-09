import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Input, Tooltip } from 'antd'
import { Keyboard, Send, Square } from 'lucide-react'
import { ContextUsageRing } from './ContextUsageRing'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type MessageInputHandle = {
  focus: () => void
  setDraft: (text: string) => void
}

type Props = {
  disabled?: boolean
  running?: boolean
  queueCount?: number
  /** 当前会话执行中的活动摘要（工具名 / 阶段） */
  runningStatus?: string
  runningDetail?: string
  runningElapsed?: string
  modelLabel?: string
  onSend: (text: string) => void
  onAbort?: () => void
}

export const MessageInput = forwardRef<MessageInputHandle, Props>(function MessageInput(
  { disabled, running, queueCount = 0, runningStatus, runningDetail, runningElapsed, modelLabel, onSend, onAbort },
  ref
) {
  const { t } = useTypedTranslation('chat')
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const leftRowRef = useRef<HTMLDivElement>(null)
  const statusMeasureRef = useRef<HTMLSpanElement>(null)
  const modelChipRef = useRef<HTMLSpanElement>(null)
  const [statusCollapsed, setStatusCollapsed] = useState(false)

  const canQueueSend = running && Boolean(text.trim())
  const hintText = running
    ? canQueueSend
      ? t('input.hintRunningQueue')
      : t('input.hintRunning')
    : t('input.hintIdle')

  const activitySummary = useMemo(() => {
    if (!running) return ''
    const parts: string[] = []
    if (runningStatus) parts.push(runningStatus)
    if (runningDetail) parts.push(runningDetail)
    if (runningElapsed) parts.push(runningElapsed)
    if (queueCount > 0) parts.push(t('input.queuePending', { count: queueCount }))
    return parts.join(' · ')
  }, [running, runningStatus, runningDetail, runningElapsed, queueCount, t])

  const showActivity = running && Boolean(activitySummary)
  /** 已有活动摘要时不再重复「执行中」；无摘要时保留停止说明 */
  const showHint = !running || canQueueSend || !showActivity

  const footerStatusLabel = useMemo(() => {
    if (!running) return hintText
    const parts: string[] = []
    if (activitySummary) parts.push(activitySummary)
    if (canQueueSend) parts.push(t('input.hintRunningQueue'))
    else if (!activitySummary) parts.push(t('input.hintRunning'))
    return parts.join(' · ')
  }, [running, hintText, activitySummary, canQueueSend, t])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setDraft: (value: string) => setText(value)
  }))

  const queueSend = () => {
    const value = text.trim()
    if (!value || disabled) return
    setText('')
    onSend(value)
  }

  const send = () => {
    if (running) {
      queueSend()
      return
    }
    const value = text.trim()
    if (!value || disabled) return
    setText('')
    onSend(value)
  }

  const checkOverflow = useCallback(() => {
    const container = leftRowRef.current
    const measure = statusMeasureRef.current
    if (!container || !measure) return

    const footer = container.parentElement
    if (!footer) return

    const rightSection = footer.lastElementChild as HTMLElement | null
    const rightWidth = rightSection ? rightSection.offsetWidth : 0
    const footerStyle = getComputedStyle(footer)
    const footerGap = parseFloat(footerStyle.columnGap) || parseFloat(footerStyle.gap) || 8
    const availableWidth = footer.clientWidth - rightWidth - footerGap

    const chipWidth = modelChipRef.current ? modelChipRef.current.offsetWidth : 0
    const statusWidth = measure.offsetWidth
    const triggerWidth = 22
    const gap = 8

    let neededWidth = statusWidth
    if (chipWidth > 0) {
      neededWidth = chipWidth + gap + statusWidth
    }

    const neededCollapsedWidth = chipWidth > 0 ? chipWidth + gap + triggerWidth : triggerWidth
    setStatusCollapsed(neededWidth > availableWidth && neededCollapsedWidth <= availableWidth)
  }, [])

  useEffect(() => {
    const container = leftRowRef.current
    if (!container) return

    const footer = container.parentElement
    if (!footer) return

    const observer = new ResizeObserver(() => {
      checkOverflow()
    })
    observer.observe(footer)

    return () => observer.disconnect()
  }, [checkOverflow])

  useEffect(() => {
    checkOverflow()
  }, [modelLabel, running, canQueueSend, queueCount, footerStatusLabel, checkOverflow])

  const handleEnter = () => {
    if (running) {
      if (text.trim()) queueSend()
      return
    }
    send()
  }

  const sendLabel = running ? t('input.queueSend') : t('input.send')
  const stopLabel = t('input.abort')

  return (
    <div className="composer">
      <div className="composer-box">
        <Input.TextArea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('input.placeholder')}
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleEnter()
            }
          }}
        />
        <div className="composer-footer">
          <div ref={leftRowRef} className="composer-footer__start">
            {modelLabel ? <span ref={modelChipRef} className="composer-model-chip">{modelLabel}</span> : null}
            <span ref={statusMeasureRef} className="composer-status composer-status--measure" aria-hidden>
              {footerStatusLabel}
            </span>
            {statusCollapsed ? (
              <Tooltip title={footerStatusLabel}>
                <button type="button" className="composer-hint-trigger" aria-label={footerStatusLabel}>
                  {running ? (
                    <span className="composer-status-trigger-dot" aria-hidden />
                  ) : (
                    <Keyboard size={14} strokeWidth={1.75} aria-hidden />
                  )}
                </button>
              </Tooltip>
            ) : (
              <div
                className={['composer-status', running ? 'composer-status--running' : ''].filter(Boolean).join(' ')}
                role={running ? 'status' : undefined}
                aria-live={running ? 'polite' : undefined}
              >
                {showActivity ? (
                  <>
                    <span className="composer-status__pulse" aria-hidden />
                    <span className="composer-status__activity">
                      {runningStatus ? <span className="composer-status__label">{runningStatus}</span> : null}
                      {runningDetail ? <span className="composer-status__detail">{runningDetail}</span> : null}
                      {runningElapsed ? <span className="composer-status__elapsed">{runningElapsed}</span> : null}
                      {queueCount > 0 ? (
                        <span className="composer-status__queue">{t('input.queuePending', { count: queueCount })}</span>
                      ) : null}
                    </span>
                    {showHint ? (
                      <>
                        <span className="composer-status__sep" aria-hidden>
                          ·
                        </span>
                        <span className="composer-status__hint">{hintText}</span>
                      </>
                    ) : null}
                  </>
                ) : showHint ? (
                  <span className="composer-status__hint">{hintText}</span>
                ) : null}
              </div>
            )}
          </div>
          <div className="composer-footer__actions">
            <ContextUsageRing />
            {running && text.trim() ? (
              <button
                type="button"
                className="composer-send composer-send--queue"
                onClick={queueSend}
                disabled={disabled}
                aria-label={sendLabel}
              >
                <span className="composer-send__visual" aria-hidden>
                  <Send size={14} />
                </span>
              </button>
            ) : null}
            {running ? (
              <button
                type="button"
                className="composer-send composer-send--stop"
                onClick={() => onAbort?.()}
                aria-label={stopLabel}
              >
                <span className="composer-send__visual" aria-hidden>
                  <Square size={14} fill="currentColor" />
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                onClick={send}
                disabled={disabled || !text.trim()}
                aria-label={sendLabel}
              >
                <span className="composer-send__visual" aria-hidden>
                  <Send size={14} />
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
