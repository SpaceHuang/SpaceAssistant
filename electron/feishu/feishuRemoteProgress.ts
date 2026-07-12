import type { LarkCliRunner } from './larkCliRunner'
import { replyFeishuText } from './feishuReply'
import { logFeishuCliEvent } from './feishuCliLogger'
import { formatRemoteProgressMessage } from '../../src/shared/remoteProgressTypes'
import { getLastPublishableSnapshot } from '../remote/remoteProgressStore'

/** @deprecated 仅 legacy 测试兼容；新代码请使用 RemoteProgressCoordinator */
export async function publishFeishuRemoteProgress(
  runner: LarkCliRunner,
  messageId: string,
  sessionId: string,
  text: string
): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  logFeishuCliEvent('info', 'feishu.remote.progress.legacy', {
    sessionId,
    messageId,
    textLen: trimmed.length
  })
  await replyFeishuText(runner, messageId, trimmed)
}

export function formatFeishuRemoteProgressPrefix(sessionId: string): string {
  const last = getLastPublishableSnapshot(sessionId)
  if (!last?.publishable) return ''
  return `${formatRemoteProgressMessage(last)}\n\n`
}

export function clearFeishuRemoteProgress(sessionId: string): void {
  void sessionId
}

export function getFeishuRemoteProgress(_sessionId: string): string | undefined {
  return undefined
}
