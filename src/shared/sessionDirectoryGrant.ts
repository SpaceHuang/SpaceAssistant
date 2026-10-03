/** 主进程保存的用户选定目录授权；Renderer 仅收到不含文件系统 identity 的视图。 */
export type SessionDirectoryGrantRecord = {
  grantId: string
  sessionId: string
  path: string
  realPath: string
  identity: { dev: number; ino: number; mode: number }
  createdAt: number
  source: 'user-selected-directory'
}

export type SessionDirectoryGrantView = Pick<SessionDirectoryGrantRecord, 'grantId' | 'sessionId' | 'path' | 'createdAt' | 'source'>

function isDrivePath(value: string): boolean {
  return /^[a-z]:\//i.test(value)
}

/** 对 POSIX、Windows drive 与 UNC 绝对路径作词法规范化。 */
export function normalizeDirectoryGrantPath(value: string): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const input = value.trim().replace(/\\/g, '/')
  const drive = isDrivePath(input)
  const unc = input.startsWith('//')
  const absolute = drive || input.startsWith('/')
  if (!absolute) return ''

  const prefix = drive ? input.slice(0, 2).toLowerCase() : unc ? '//' : '/'
  const rest = drive ? input.slice(3) : unc ? input.slice(2) : input.slice(1)
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > (unc ? 2 : 0)) parts.pop()
      continue
    }
    parts.push(part)
  }
  const body = (drive || unc ? parts.map((part) => part.toLowerCase()) : parts).join('/')
  if (drive) return `${prefix}/${body}`.replace(/\/$/, '') || `${prefix}/`
  if (unc) return `//${body}`
  return `/${body}`
}

/** containment 使用路径段边界；Windows 路径按不区分大小写处理。 */
export function isPathWithinGrantedDirectory(targetPath: string, grantRoot: string): boolean {
  const target = normalizeDirectoryGrantPath(targetPath)
  const root = normalizeDirectoryGrantPath(grantRoot)
  if (!target || !root) return false
  const windows = isDrivePath(target) || isDrivePath(root) || target.startsWith('//') || root.startsWith('//')
  const candidate = windows ? target.toLowerCase() : target
  const boundary = windows ? root.toLowerCase() : root
  return candidate === boundary || candidate.startsWith(`${boundary.replace(/\/$/, '')}/`)
}

export function toSessionDirectoryGrantView(record: SessionDirectoryGrantRecord): SessionDirectoryGrantView {
  return { grantId: record.grantId, sessionId: record.sessionId, path: record.path, createdAt: record.createdAt, source: record.source }
}

export function buildSessionDirectoryContextBlock(records: readonly SessionDirectoryGrantRecord[], locale: 'zh-CN' | 'en-US'): string {
  if (!records.length) return ''
  const directoryList = records.map((record) => `- ${record.realPath}`).join('\n')
  return locale === 'zh-CN'
    ? `\n\n用户为当前桌面会话选定了以下额外目录上下文：\n${directoryList}\n仅在任务需要时通过 read_file、list_directory 或 grep 读取这些目录范围内的内容；选择目录不表示要求立即扫描全部内容。目录选择不批准写入、Shell 或其他破坏性操作，仍须遵循现有安全策略与确认。`
    : `\n\nThe user selected these additional directories for the current desktop session:\n${directoryList}\nRead within these directories with read_file, list_directory, or grep only when the task requires it; selecting a directory does not request a full scan. Directory selection does not approve writes, shell commands, or other destructive actions. Existing safety rules and confirmations still apply.`
}
