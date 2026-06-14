import type { SessionUsage } from '../../shared/sessionUsage'
import { store } from '../store'
import { setLastUsage } from '../store/chatSlice'

export function applyContextUsageUpdate(sessionId: string, usage: SessionUsage): void {
  void window.api.usageSet({ sessionId, usage }).catch(() => {})
  if (store.getState().chat.currentSessionId === sessionId) {
    store.dispatch(setLastUsage({ sessionId, usage }))
  }
}

/** 全局订阅 claude-chat-usage，工具 loop 中间轮次与 tool_result 投影均可实时更新环。 */
export function initContextUsageStreamBridge(): () => void {
  return window.api.claudeChatOnUsage((d) => {
    applyContextUsageUpdate(d.sessionId, d.usage)
  })
}
