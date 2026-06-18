import type { Message } from '../src/shared/domainTypes'
import type { ClaudeChatMessageWithBlocks } from '../src/shared/api'
import { buildClaudeToolChatMessages } from '../src/shared/claudeToolHistory'
import { resolveChatAttachmentBase64 } from './chatAttachmentManager'

export async function buildToolChatMessagesFromSource(args: {
  userDataDir: string
  sourceMessages: Message[]
  currentUserMessageId: string
}): Promise<ClaudeChatMessageWithBlocks[]> {
  const imageCache = new Map<string, { mimeType: string; data: string }>()
  for (const m of args.sourceMessages) {
    if (!m.attachments?.length) continue
    for (const a of m.attachments) {
      if (imageCache.has(a.stagingKey)) continue
      const resolved = await resolveChatAttachmentBase64(args.userDataDir, a.stagingKey)
      if (resolved) imageCache.set(a.stagingKey, resolved)
    }
  }
  const resolveImage = (a: { stagingKey: string }) => imageCache.get(a.stagingKey) ?? null
  return buildClaudeToolChatMessages(args.sourceMessages, {
    currentUserMessageId: args.currentUserMessageId,
    resolveImage
  })
}
