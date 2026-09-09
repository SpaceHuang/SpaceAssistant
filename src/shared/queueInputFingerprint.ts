import type { ChatImageAttachment } from './domainTypes'

export type QueueInputFingerprintInput = {
  text: string
  attachments?: ChatImageAttachment[]
}

export function canonicalQueueInput(input: QueueInputFingerprintInput): string {
  const attachments = (input.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    stagingKey: attachment.stagingKey,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    ...(attachment.width == null ? {} : { width: attachment.width }),
    ...(attachment.height == null ? {} : { height: attachment.height })
  }))
  return JSON.stringify({ v: 1, text: input.text.trim(), attachments })
}
