import type { Message } from './domainTypes'

export type QueueInputFingerprintInput = {
  text: string
  attachments?: Message['attachments']
}

export function canonicalQueueInput(input: QueueInputFingerprintInput): string {
  const attachments = (input.attachments ?? []).map((attachment) => 'source' in attachment
    ? { id: attachment.id, source: attachment.source, kind: attachment.kind, fileName: attachment.fileName, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) }
    : { id: attachment.id, stagingKey: attachment.stagingKey, fileName: attachment.fileName, mimeType: attachment.mimeType, byteLength: attachment.byteLength,
        ...(attachment.width == null ? {} : { width: attachment.width }), ...(attachment.height == null ? {} : { height: attachment.height }) })
  return JSON.stringify({ v: 1, text: input.text.trim(), attachments })
}
