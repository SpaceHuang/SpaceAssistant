import { memo, useEffect, useState } from 'react'
import type { ChatImageAttachment } from '../../../shared/domainTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  sessionId: string
  attachments: ChatImageAttachment[]
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const ChatMessageAttachments = memo(function ChatMessageAttachments({ sessionId, attachments }: Props) {
  const { t } = useTypedTranslation('chat')
  const [urls, setUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const next: Record<string, string> = {}
      for (const a of attachments) {
        const res = await window.api.chatReadStagedImage({
          sessionId,
          stagingKey: a.stagingKey
        })
        if ('error' in res) continue
        next[a.id] = `data:${res.mimeType};base64,${res.dataBase64}`
      }
      if (!cancelled) setUrls(next)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [sessionId, attachments])

  if (!attachments.length) return null

  return (
    <div className="chat-message-attachments">
      {attachments.map((a) => (
        <div key={a.id} className="chat-message-attachment-chip" title={a.fileName}>
          {urls[a.id] ? (
            <img src={urls[a.id]} alt={t('attachment.alt', { name: a.fileName })} className="chat-message-attachment-thumb" />
          ) : (
            <span className="chat-message-attachment-thumb chat-message-attachment-thumb--loading" aria-hidden />
          )}
          <span className="chat-message-attachment-name">{a.fileName}</span>
          <span className="chat-message-attachment-size">{formatByteSize(a.byteLength)}</span>
        </div>
      ))}
    </div>
  )
})
