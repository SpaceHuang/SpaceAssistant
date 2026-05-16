/** 归一化工作区相对路径（用于跨会话写冲突检测） */
export function normalizeToolRelPath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
}

const writePathOwners = new Map<string, string>()

export function checkWritePathConflict(sessionId: string, relPath: string): string | null {
  const key = normalizeToolRelPath(relPath)
  if (!key) return null
  const owner = writePathOwners.get(key)
  if (owner && owner !== sessionId) {
    return `文件「${key}」正被其他会话占用写入，请稍后再试或切换到该会话后再操作。`
  }
  return null
}

export function claimWritePath(sessionId: string, relPath: string): void {
  const key = normalizeToolRelPath(relPath)
  if (key) writePathOwners.set(key, sessionId)
}

export function releaseWritePath(sessionId: string, relPath: string): void {
  const key = normalizeToolRelPath(relPath)
  if (!key) return
  if (writePathOwners.get(key) === sessionId) writePathOwners.delete(key)
}

export function releaseAllWritePathsForSession(sessionId: string): void {
  for (const [path, owner] of writePathOwners) {
    if (owner === sessionId) writePathOwners.delete(path)
  }
}

/** 测试用 */
export function clearWritePathOwners(): void {
  writePathOwners.clear()
}
