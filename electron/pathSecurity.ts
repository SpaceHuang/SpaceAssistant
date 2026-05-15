import fs from 'fs/promises'
import path from 'path'

/** 防止路径穿越：resolved 必须落在 basePath 之下（含 Windows 大小写/分隔符） */
export function resolveSafePath(basePath: string, relativePath: string): string {
  const base = path.resolve(basePath)
  const resolved = path.resolve(base, relativePath)
  const rel = path.relative(base, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径超出工作目录范围')
  }
  return resolved
}

/** 解析 realpath 后再次校验仍在工作目录内（用于跟符号链接） */
export async function resolveSafePathReal(basePath: string, relativePath: string): Promise<string> {
  const resolved = resolveSafePath(basePath, relativePath)
  try {
    const baseReal = await fs.realpath(path.resolve(basePath))
    const targetReal = await fs.realpath(resolved)
    const rel = path.relative(baseReal, targetReal)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('路径超出工作目录范围')
    }
    return targetReal
  } catch (e) {
    if (e instanceof Error && e.message.includes('路径超出')) throw e
    return resolved
  }
}
