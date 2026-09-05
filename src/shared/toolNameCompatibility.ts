export interface NormalizedExternalToolName {
  canonicalName: string
  originalName?: string
}

/** 仅在外部协议边界兼容旧 Bash 名称；内部策略和执行始终只使用 run_shell。 */
export function normalizeExternalToolName(name: string): NormalizedExternalToolName {
  if (name === 'Bash' || name === 'bash') {
    return { canonicalName: 'run_shell', originalName: name }
  }
  return { canonicalName: name }
}
