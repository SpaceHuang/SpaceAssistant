import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Input, Tooltip } from 'antd'
import { Keyboard, Plus, Send, Square, X } from 'lucide-react'
import { ContextUsageRing } from './ContextUsageRing'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { ChatImageAttachment } from '../../../shared/domainTypes'
import { MAX_CHAT_IMAGE_ATTACHMENTS } from '../../../shared/chatAttachmentLimits'
import { getFileExtension, getImageMimeType } from '../../../shared/fileTypes'

export type MessageInputHandle = {
  focus: () => void
  setDraft: (text: string) => void
  clearPendingAttachments: () => void
}

type PendingAttachment = ChatImageAttachment & {
  previewUrl?: string
  status: 'staging' | 'ready' | 'error'
}

type Props = {
  disabled?: boolean
  running?: boolean
  queueCount?: number
  /** 当前会话执行中的活动摘要（工具名 / 阶段） */
  runningStatus?: string
  runningDetail?: string
  runningElapsed?: string
  modelSlot?: React.ReactNode
  sessionId?: string
  toolsEnabled?: boolean
  onSend: (text: string, attachments?: ChatImageAttachment[]) => void
  onAbort?: () => void
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('read_failed'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'))
    reader.readAsDataURL(file)
  })
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function toChatAttachment(item: PendingAttachment): ChatImageAttachment {
  const { previewUrl: _previewUrl, status: _status, ...attachment } = item
  return attachment
}

export const MessageInput = forwardRef<MessageInputHandle, Props>(function MessageInput(
  {
    disabled,
    running,
    queueCount = 0,
    runningStatus,
    runningDetail,
    runningElapsed,
    modelSlot,
    sessionId,
    toolsEnabled: _toolsEnabled,
    onSend,
    onAbort
  },
  ref
) {
  const { t } = useTypedTranslation('chat')
  const [text, setText] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [tooManyHint, setTooManyHint] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const leftRowRef = useRef<HTMLDivElement>(null)
  const statusMeasureRef = useRef<HTMLSpanElement>(null)
  const modelChipRef = useRef<HTMLSpanElement>(null)
  const attachButtonRef = useRef<HTMLButtonElement>(null)
  const [statusCollapsed, setStatusCollapsed] = useState(false)

  const readyAttachments = useMemo(
    () => pendingAttachments.filter((a) => a.status === 'ready').map(toChatAttachment),
    [pendingAttachments]
  )

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

  const revokePreviewUrls = useCallback((items: PendingAttachment[]) => {
    for (const item of items) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    }
  }, [])

  const discardAttachment = useCallback(
    async (item: PendingAttachment) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
      if (sessionId && item.stagingKey && item.status === 'ready') {
        await window.api.chatDiscardStagedImage({ sessionId, stagingKey: item.stagingKey })
      }
    },
    [sessionId]
  )

  const pendingAttachmentsRef = useRef(pendingAttachments)
  pendingAttachmentsRef.current = pendingAttachments

  const clearPendingAttachments = useCallback(async () => {
    const snapshot = pendingAttachmentsRef.current
    setPendingAttachments([])
    revokePreviewUrls(snapshot)
    await Promise.all(snapshot.map((item) => discardAttachment(item)))
  }, [revokePreviewUrls, discardAttachment])

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      setDraft: (value: string) => setText(value),
      clearPendingAttachments: () => {
        void clearPendingAttachments()
      }
    }),
    [clearPendingAttachments]
  )

  useEffect(() => {
    return () => {
      revokePreviewUrls(pendingAttachmentsRef.current)
    }
  }, [revokePreviewUrls])

  const clearComposerAttachments = useCallback(() => {
    revokePreviewUrls(pendingAttachments)
    setPendingAttachments([])
  }, [pendingAttachments, revokePreviewUrls])

  const queueSend = () => {
    const value = text.trim()
    if (!value || disabled) return
    const attachments = readyAttachments.length > 0 ? readyAttachments : undefined
    setText('')
    clearComposerAttachments()
    onSend(value, attachments)
  }

  const send = () => {
    if (running) {
      queueSend()
      return
    }
    const value = text.trim()
    if (!value || disabled) return
    const attachments = readyAttachments.length > 0 ? readyAttachments : undefined
    setText('')
    clearComposerAttachments()
    onSend(value, attachments)
  }

  const removeAttachment = useCallback(
    (id: string) => {
      setPendingAttachments((prev) => {
        const target = prev.find((a) => a.id === id)
        if (target) void discardAttachment(target)
        return prev.filter((a) => a.id !== id)
      })
    },
    [discardAttachment]
  )

  const stageFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!sessionId || disabled) return

      const fileArray = Array.from(files)
      if (fileArray.length === 0) return

      let remaining = 0
      setPendingAttachments((prev) => {
        const currentCount = prev.filter((a) => a.status !== 'error').length
        remaining = MAX_CHAT_IMAGE_ATTACHMENTS - currentCount
        return prev
      })

      if (remaining <= 0) {
        setTooManyHint(true)
        return
      }

      const batch = fileArray.slice(0, remaining)
      if (batch.length < fileArray.length) {
        setTooManyHint(true)
      }

      for (const file of batch) {
        const ext = getFileExtension(file.name)
        const mimeType = getImageMimeType(ext)
        if (!mimeType) continue

        const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const previewUrl = URL.createObjectURL(file)
        setPendingAttachments((prev) => [
          ...prev,
          {
            id: tempId,
            stagingKey: '',
            fileName: file.name,
            mimeType,
            byteLength: file.size,
            previewUrl,
            status: 'staging'
          }
        ])

        try {
          const dataBase64 = await readFileAsBase64(file)
          const result = await window.api.chatStageImage({
            sessionId,
            fileName: file.name,
            mimeType,
            dataBase64
          })

          if ('error' in result) {
            URL.revokeObjectURL(previewUrl)
            setPendingAttachments((prev) => prev.filter((a) => a.id !== tempId))
            continue
          }

          setPendingAttachments((prev) =>
            prev.map((a) =>
              a.id === tempId
                ? {
                    ...result,
                    previewUrl,
                    status: 'ready' as const
                  }
                : a
            )
          )
        } catch {
          URL.revokeObjectURL(previewUrl)
          setPendingAttachments((prev) => prev.filter((a) => a.id !== tempId))
        }
      }
    },
    [sessionId, disabled]
  )

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files?.length) void stageFiles(files)
    e.target.value = ''
  }

  const preventDragDefaults = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
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

    const attachWidth = attachButtonRef.current ? attachButtonRef.current.offsetWidth : 28
    const chipWidth = modelChipRef.current ? modelChipRef.current.offsetWidth : 0
    const statusWidth = measure.offsetWidth
    const triggerWidth = 22
    const gap = 8

    let neededWidth = attachWidth + statusWidth
    if (chipWidth > 0) {
      neededWidth = attachWidth + gap + chipWidth + gap + statusWidth
    } else {
      neededWidth = attachWidth + gap + statusWidth
    }

    let neededCollapsedWidth = attachWidth + gap + triggerWidth
    if (chipWidth > 0) {
      neededCollapsedWidth = attachWidth + gap + chipWidth + gap + triggerWidth
    }

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
  }, [modelSlot, running, canQueueSend, queueCount, footerStatusLabel, pendingAttachments.length, checkOverflow])

  useEffect(() => {
    if (!tooManyHint) return
    const timer = window.setTimeout(() => setTooManyHint(false), 4000)
    return () => window.clearTimeout(timer)
  }, [tooManyHint])

  const handleEnter = () => {
    if (running) {
      if (text.trim()) queueSend()
      return
    }
    send()
  }

  const sendLabel = running ? t('input.queueSend') : t('input.send')
  const stopLabel = t('input.abort')
  const hasStaging = pendingAttachments.some((a) => a.status === 'staging')

  return (
    <div className="composer">
      <div
        className="composer-box"
        onDragEnter={preventDragDefaults}
        onDragOver={preventDragDefaults}
        onDrop={preventDragDefaults}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={handleFileInputChange}
        />
        {pendingAttachments.length > 0 ? (
          <div className="composer-attachments">
            {tooManyHint ? (
              <span className="composer-attachments__hint">{t('input.tooManyImages', { max: MAX_CHAT_IMAGE_ATTACHMENTS })}</span>
            ) : null}
            {pendingAttachments.map((a) => (
              <div
                key={a.id}
                className={[
                  'composer-attachment-chip',
                  a.status === 'staging' ? 'composer-attachment-chip--staging' : '',
                  a.status === 'error' ? 'composer-attachment-chip--error' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                title={a.fileName}
              >
                {a.previewUrl ? (
                  <img
                    src={a.previewUrl}
                    alt={t('attachment.alt', { name: a.fileName })}
                    className="composer-attachment-chip__thumb"
                  />
                ) : (
                  <span className="composer-attachment-chip__thumb composer-attachment-chip__thumb--empty" aria-hidden />
                )}
                <span className="composer-attachment-chip__name">{a.fileName}</span>
                <span className="composer-attachment-chip__size">{formatByteSize(a.byteLength)}</span>
                <button
                  type="button"
                  className="composer-attachment-chip__remove"
                  onClick={() => removeAttachment(a.id)}
                  disabled={a.status === 'staging'}
                  aria-label={t('attachment.remove', { name: a.fileName })}
                >
                  <X size={12} strokeWidth={2} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        ) : tooManyHint ? (
          <div className="composer-attachments composer-attachments--hint-only">
            <span className="composer-attachments__hint">{t('input.tooManyImages', { max: MAX_CHAT_IMAGE_ATTACHMENTS })}</span>
          </div>
        ) : null}
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
            <Tooltip title={tooManyHint ? t('input.tooManyImages', { max: MAX_CHAT_IMAGE_ATTACHMENTS }) : undefined}>
              <button
                ref={attachButtonRef}
                type="button"
                className="composer-add-attachment"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || !sessionId || hasStaging}
                aria-label={t('input.addImage')}
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </Tooltip>
            {modelSlot ? <span ref={modelChipRef}>{modelSlot}</span> : null}
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
            <ContextUsageRing pendingImageAttachments={readyAttachments} />
            {running && text.trim() ? (
              <button
                type="button"
                className="composer-send composer-send--queue"
                onClick={queueSend}
                disabled={disabled || hasStaging}
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
                disabled={disabled || !text.trim() || hasStaging}
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
