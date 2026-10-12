import fs from 'node:fs/promises'

/**
 * 目录 fsync 仅是 POSIX 上的落盘耐久性收尾步骤；Windows 无法对目录句柄执行 fsync
 * （Node 实测：fs.open(目录, 'r') 可以打开，但 handle.sync() 恒抛 EPERM）。
 * 因此 win32 直接跳过；其余平台容忍不支持类错误码，其余错误照常上抛。
 */
export async function syncDirectoryBestEffort(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export function directorySyncUnsupported(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR' || code === 'EPERM' || code === 'EACCES'
}
