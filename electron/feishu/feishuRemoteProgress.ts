import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuText } from './feishuReply'
import { logFeishuCliEvent } from './feishuCliLogger'

const lastProgressBySession = new Map<string, string>()

export function getFeishuRemoteProgress(sessionId: string): string | undefined {
  return lastProgressBySession.get(sessionId)
}

export function clearFeishuRemoteProgress(sessionId: string): void {
  lastProgressBySession.delete(sessionId)
}

export async function publishFeishuRemoteProgress(
  runner: LarkCliRunner,
  messageId: string,
  sessionId: string,
  text: string
): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  const prev = lastProgressBySession.get(sessionId)
  if (prev === trimmed) return
  lastProgressBySession.set(sessionId, trimmed)
  logFeishuCliEvent('info', 'feishu.remote.progress', {
    sessionId,
    messageId,
    textLen: trimmed.length
  })
  await replyFeishuText(runner, messageId, trimmed)
}

export function formatFeishuRemoteProgressPrefix(sessionId: string): string {
  const progress = getFeishuRemoteProgress(sessionId)
  if (!progress) return ''
  return `【进度说明】\n${progress.slice(0, 600)}\n\n`
}
