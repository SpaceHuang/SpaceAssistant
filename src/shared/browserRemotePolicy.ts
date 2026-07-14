import { ErrorCodes } from './errorCodes'

/** browser 在 IM 远程会话中被 allowRemoteSessions 拦截时的 tool_result 错误码 */
export const BROWSER_REMOTE_DISABLED_CODE = ErrorCodes.BROWSER_REMOTE_DISABLED

/** @deprecated 使用 BROWSER_REMOTE_DISABLED_CODE */
export const BROWSER_FEISHU_REMOTE_DISABLED_CODE = ErrorCodes.BROWSER_FEISHU_REMOTE_DISABLED

/** @deprecated 使用 BROWSER_REMOTE_DISABLED_CODE + formatUserFacingError */
export const BROWSER_FEISHU_REMOTE_DISABLED_ERROR = BROWSER_REMOTE_DISABLED_CODE

export type FeishuBrowserRemoteHint = 'available' | 'blocked' | 'off'

export function resolveFeishuBrowserRemoteHint(
  browserEnabled: boolean | undefined,
  allowRemoteSessions: boolean | undefined
): FeishuBrowserRemoteHint {
  if (!browserEnabled) return 'off'
  return allowRemoteSessions ? 'available' : 'blocked'
}
