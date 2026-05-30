/** browser 在飞书远程会话中被 allowRemoteSessions 拦截时的 tool_result 文案 */
export const BROWSER_FEISHU_REMOTE_DISABLED_ERROR =
  '飞书远程会话未启用浏览器工具。请在 SpaceAssistant 桌面端打开「设置 → 浏览器」，开启「允许飞书远程会话使用」后重试。'

export type FeishuBrowserRemoteHint = 'available' | 'blocked' | 'off'

export function resolveFeishuBrowserRemoteHint(
  browserEnabled: boolean | undefined,
  allowRemoteSessions: boolean | undefined
): FeishuBrowserRemoteHint {
  if (!browserEnabled) return 'off'
  return allowRemoteSessions ? 'available' : 'blocked'
}
