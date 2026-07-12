import { createHash } from 'crypto'
import { progressReplyDedupeKey } from '../../src/shared/remoteOutboundFormat'
import {
  mergeRemoteProgressConfig,
  resolveHeartbeatProgressText,
  type RemoteProgressConfig
} from '../../src/shared/remoteProgressTypes'
import {
  getCurrentRemoteProgressSnapshot,
  getLastPublishableSnapshot,
  getLastRemoteProgressReply,
  markRemoteProgressReplySent
} from './remoteProgressStore'

export type RemoteProgressAdapter = {
  channel: 'wechat' | 'feishu'
  sendTyping?: () => void | Promise<void>
  reply: (text: string) => void | Promise<void>
  logProgress?: (payload: { sessionId: string; textLen: number; textHash: string }) => void
}

type ActiveSession = {
  sessionId: string
  adapter: RemoteProgressAdapter
  config: Required<RemoteProgressConfig>
  typingTimer?: ReturnType<typeof setInterval>
  heartbeatTimer?: ReturnType<typeof setInterval>
}

const activeSessions = new Map<string, ActiveSession>()

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function startRemoteProgressSession(
  sessionId: string,
  adapter: RemoteProgressAdapter,
  partialConfig?: RemoteProgressConfig,
  defaults?: Required<RemoteProgressConfig>
): void {
  stopRemoteProgressSession(sessionId)
  const config = mergeRemoteProgressConfig(partialConfig, defaults)
  if (config.remoteProgressMode === 'off') return

  const entry: ActiveSession = { sessionId, adapter, config }
  activeSessions.set(sessionId, entry)

  if (config.remoteTypingEnabled && adapter.sendTyping) {
    void adapter.sendTyping()
    entry.typingTimer = setInterval(() => {
      void adapter.sendTyping?.()
    }, 15_000)
  }

  const heartbeatSec = config.remoteProgressHeartbeatSec
  if (heartbeatSec > 0) {
    entry.heartbeatTimer = setInterval(() => {
      void runHeartbeat(sessionId)
    }, heartbeatSec * 1000)
  }
}

export function stopRemoteProgressSession(sessionId: string): void {
  const entry = activeSessions.get(sessionId)
  if (!entry) return
  if (entry.typingTimer) clearInterval(entry.typingTimer)
  if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer)
  activeSessions.delete(sessionId)
}

export async function sendInstantRemoteProgressReply(sessionId: string, text: string): Promise<boolean> {
  const entry = activeSessions.get(sessionId)
  if (!entry || entry.config.remoteProgressMode === 'off') return false
  return sendProgressReply(sessionId, text, { bypassMinInterval: true })
}

async function sendProgressReply(
  sessionId: string,
  text: string,
  opts?: { bypassMinInterval?: boolean }
): Promise<boolean> {
  const entry = activeSessions.get(sessionId)
  if (!entry) return false

  const trimmed = text.trim()
  if (!trimmed) return false

  const dedupeKey = progressReplyDedupeKey(trimmed)
  const last = getLastRemoteProgressReply(sessionId)
  if (last.text && progressReplyDedupeKey(last.text) === dedupeKey) return false

  if (!opts?.bypassMinInterval && last.at) {
    const minMs = entry.config.remoteProgressMinIntervalSec * 1000
    if (Date.now() - last.at < minMs) return false
  }

  await entry.adapter.reply(trimmed)
  markRemoteProgressReplySent(sessionId, trimmed)
  entry.adapter.logProgress?.({
    sessionId,
    textLen: trimmed.length,
    textHash: hashText(trimmed)
  })
  return true
}

export async function runHeartbeat(sessionId: string): Promise<boolean> {
  const entry = activeSessions.get(sessionId)
  if (!entry) return false

  const { config } = entry
  if (config.remoteProgressMode === 'off') return false

  let text: string
  if (config.remoteProgressMode === 'legacy_heartbeat') {
    text = config.remoteProgressFallbackText
  } else {
    const current = getCurrentRemoteProgressSnapshot(sessionId)
    const lastPublishable = getLastPublishableSnapshot(sessionId)
    text = resolveHeartbeatProgressText({
      current,
      lastPublishable,
      fallback: config.remoteProgressFallbackText,
      maxChars: config.remoteProgressMaxChars
    }).text
  }

  return sendProgressReply(sessionId, text)
}

export function isRemoteProgressSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId)
}

export function clearAllRemoteProgressCoordinatorSessions(): void {
  for (const sessionId of [...activeSessions.keys()]) {
    stopRemoteProgressSession(sessionId)
  }
}
