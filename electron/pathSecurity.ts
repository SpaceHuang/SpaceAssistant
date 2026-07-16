import fs from 'fs/promises'
import path from 'path'
import type { Stats } from 'fs'

/** 规范化相对路径参数（统一 `/` 分隔符，去掉 leading slash） */
export function normalizeRelPathInput(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** 防止路径穿越：resolved 必须落在 basePath 之下（含 Windows 大小写/分隔符） */
export function resolveSafePath(basePath: string, relativePath: string): string {
  const base = path.resolve(basePath)
  const resolved = path.resolve(base, normalizeRelPathInput(relativePath))
  const rel = path.relative(base, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径超出工作目录范围')
  }
  return resolved
}

function assertInsideBase(baseReal: string, candidateReal: string): void {
  const rel = path.relative(baseReal, candidateReal)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径超出工作目录范围')
  }
}

/** 解析 realpath 后再次校验仍在工作目录内（用于跟符号链接；读路径使用） */
export async function resolveSafePathReal(basePath: string, relativePath: string): Promise<string> {
  const resolved = resolveSafePath(basePath, relativePath)
  try {
    const baseReal = await fs.realpath(path.resolve(basePath))
    const targetReal = await fs.realpath(resolved)
    assertInsideBase(baseReal, targetReal)
    return targetReal
  } catch (e) {
    if (e instanceof Error && e.message.includes('路径超出')) throw e
    return resolved
  }
}

export type SafeWriteTarget = {
  /** 词法解析后的目标绝对路径（不跟随符号链接） */
  targetPath: string
  /** 最近存在父目录的 realpath */
  parentReal: string
  /** 目标是否已存在且为普通文件 */
  existed: boolean
  /** 已存在目标的 lstat 快照（用于后续 identity 比对） */
  existingStat: Stats | null
}

/**
 * 受控写入路径解析：词法边界 → 逐段 lstat（拒 symlink/非目录）→
 * 工作目录根与最近存在父目录 realpath 包含校验。
 * 目标已存在时必须是普通文件。
 * 返回的 targetPath 落在 parentReal 之下（与读路径 realpath 键一致）。
 */
export async function resolveSafeWriteTarget(
  basePath: string,
  relativePath: string
): Promise<SafeWriteTarget> {
  const base = path.resolve(basePath)
  const lexicalTarget = resolveSafePath(base, relativePath)

  let baseLstat: Stats
  try {
    baseLstat = await fs.lstat(base)
  } catch {
    throw new Error('工作目录不可用')
  }
  if (baseLstat.isSymbolicLink() || !baseLstat.isDirectory()) {
    throw new Error('工作目录不可用')
  }

  const baseReal = await fs.realpath(base)

  const relFromBase = path.relative(base, lexicalTarget)
  const segments = relFromBase.split(path.sep).filter(Boolean)
  let walked = base
  let nearestExistingParent = base
  let nearestExistingParentReal = baseReal

  const toCanonical = (lexical: string): string => {
    const suffix = path.relative(nearestExistingParent, lexical)
    return path.join(nearestExistingParentReal, suffix)
  }

  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1
    walked = path.join(walked, segments[i]!)
    let st: Stats
    try {
      st = await fs.lstat(walked)
    } catch (e: unknown) {
      const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : ''
      if (code === 'ENOENT') {
        if (!isLast) {
          break
        }
        const targetPath = toCanonical(lexicalTarget)
        assertInsideBase(baseReal, path.dirname(targetPath) === nearestExistingParentReal
          ? nearestExistingParentReal
          : path.dirname(targetPath))
        // 确保目标本身在 baseReal 内
        assertInsideBase(baseReal, targetPath)
        return {
          targetPath,
          parentReal: nearestExistingParentReal,
          existed: false,
          existingStat: null
        }
      }
      throw new Error('路径组件无法判定')
    }

    if (st.isSymbolicLink()) {
      throw new Error('路径包含符号链接，拒绝写入')
    }
    if (isLast) {
      if (!st.isFile()) {
        throw new Error('写入目标必须是普通文件')
      }
      if (typeof st.nlink === 'number' && st.nlink > 1) {
        throw new Error('拒绝写入硬链接目标')
      }
      const targetPath = toCanonical(lexicalTarget)
      assertInsideBase(baseReal, targetPath)
      return {
        targetPath,
        parentReal: nearestExistingParentReal,
        existed: true,
        existingStat: st
      }
    }
    if (!st.isDirectory()) {
      throw new Error('路径组件不是目录')
    }
    nearestExistingParent = walked
    nearestExistingParentReal = await fs.realpath(walked)
    assertInsideBase(baseReal, nearestExistingParentReal)
  }

  const targetPath = toCanonical(lexicalTarget)
  assertInsideBase(baseReal, targetPath)
  return {
    targetPath,
    parentReal: nearestExistingParentReal,
    existed: false,
    existingStat: null
  }
}
