import path from 'path'

/** 防止路径穿越：resolved 必须落在 basePath 之下 */
export function resolveSafePath(basePath: string, relativePath: string): string {
  const base = path.resolve(basePath)
  const resolved = path.resolve(base, relativePath)
  if (!resolved.startsWith(base)) {
    throw new Error('路径遍历攻击检测')
  }
  return resolved
}
