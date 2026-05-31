import type { ShellConfig, ShellOutputMode } from './domainTypes'

export type { ShellOutputMode } from './domainTypes'

export function isFeishuSessionMetadata(metadata?: Record<string, unknown> | null): boolean {
  return metadata?.source === 'feishu'
}

/** 有效 shell 输出模式：飞书会话 / 远程 headless 强制 plain */
export function resolveEffectiveShellOutputMode(
  shellConfig: ShellConfig | undefined | null,
  sessionMetadata?: Record<string, unknown> | null,
  remoteSource?: string
): ShellOutputMode {
  if (isFeishuSessionMetadata(sessionMetadata) || remoteSource === 'feishu') {
    return 'plain'
  }
  return shellConfig?.outputMode ?? 'terminal'
}
