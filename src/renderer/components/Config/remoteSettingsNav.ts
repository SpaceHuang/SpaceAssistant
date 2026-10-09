export const REMOTE_SETTINGS_KEYS = ['remoteIm', 'feishu', 'wechat'] as const

export type RemoteSettingsKey = (typeof REMOTE_SETTINGS_KEYS)[number]

export function isRemoteSettingsKey(key: string): key is RemoteSettingsKey {
  return (REMOTE_SETTINGS_KEYS as readonly string[]).includes(key)
}
