import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Input, Tooltip } from 'antd'
import { Keyboard, Send, Square } from 'lucide-react'
import { ContextUsageRing } from './ContextUsageRing'

export type MessageInputHandle = {
  focus: () => void
  setDraft: (text: string) => void
}

type Props = {
  disabled?: boolean
  running?: boolean
  modelLabel?: string
  onSend: (text: string) => void
  onAbort?: () => void
}

export const MessageInput = forwardRef<MessageInputHandle, Props>(function MessageInput(
  { disabled, running, modelLabel, onSend, onAbort },
  ref
) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const leftRowRef = useRef<HTMLDivElement>(null)
  const hintMeasureRef = useRef<HTMLSpanElement>(null)
  const modelChipRef = useRef<HTMLSpanElement>(null)
  const [hintCollapsed, setHintCollapsed] = useState(false)

  const hintText = running ? '执行中，Enter 或点击右侧按钮中止' : 'Enter 发送，Shift+Enter 换行'
  const primaryActionLabel = running ? '中止生成' : '发送消息'

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setDraft: (t: string) => setText(t)
  }))

  const send = () => {
    const t = text.trim()
    if (!t || disabled || running) return
    setText('')
    onSend(t)
  }

  const checkOverflow = useCallback(() => {
    const container = leftRowRef.current
    const hint = hintMeasureRef.current
    if (!container || !hint) return

    const footer = container.parentElement
    if (!footer) return

    const rightSection = footer.lastElementChild as HTMLElement | null
    const rightWidth = rightSection ? rightSection.offsetWidth : 0
    const footerStyle = getComputedStyle(footer)
    const footerGap = parseFloat(footerStyle.columnGap) || parseFloat(footerStyle.gap) || 8
    const availableWidth = footer.clientWidth - rightWidth - footerGap

    const chipWidth = modelChipRef.current ? modelChipRef.current.offsetWidth : 0
    const hintWidth = hint.offsetWidth
    const triggerWidth = 22
    const gap = 8

    let neededWidth = hintWidth
    if (chipWidth > 0) {
      neededWidth = chipWidth + gap + hintWidth
    }

    const neededCollapsedWidth = chipWidth > 0 ? chipWidth + gap + triggerWidth : triggerWidth
    setHintCollapsed(neededWidth > availableWidth && neededCollapsedWidth <= availableWidth)
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
  }, [modelLabel, running, hintText, checkOverflow])

  const handlePrimaryAction = () => {
    if (running) {
      onAbort?.()
      return
    }
    send()
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <Input.TextArea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入消息…"
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handlePrimaryAction()
            }
          }}
        />
        <div className="composer-footer">
          <div ref={leftRowRef} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
            {modelLabel ? <span ref={modelChipRef} className="composer-model-chip">{modelLabel}</span> : null}
            <span ref={hintMeasureRef} className="composer-hint composer-hint--measure" aria-hidden>
              {hintText}
            </span>
            {hintCollapsed ? (
              <Tooltip title={hintText}>
                <button type="button" className="composer-hint-trigger" aria-label={hintText}>
                  <Keyboard size={14} strokeWidth={1.75} aria-hidden />
                </button>
              </Tooltip>
            ) : (
              <span className="composer-hint">{hintText}</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ContextUsageRing />
            <button
              type="button"
              className={`composer-send${running ? ' composer-send--stop' : ''}`}
              onClick={handlePrimaryAction}
              disabled={running ? false : disabled || !text.trim()}
              aria-label={primaryActionLabel}
            >
              <span className="composer-send__visual" aria-hidden>
                {running ? <Square size={14} fill="currentColor" /> : <Send size={14} />}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
})
