import path from 'path'
import fs from 'fs/promises'
import { resolveSafePath, resolveSafePathReal, normalizeRelPathInput } from '../pathSecurity'
import type { WorkspaceLayoutConfig } from '../../src/shared/domainTypes'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export interface RedirectOutcome {
  redirected: boolean
  newPath?: string
  originalPath?: string
  reason?: string
  reject?: boolean
  rejectReason?: string
}

export interface RedirectArgs {
  toolName: string
  input: Record<string, unknown>
  workDir: string
  sessionId: string
  workspaceLayout: WorkspaceLayoutConfig
  writeDirChoice: { dir: string } | null
}

function sanitizeBasename(basename: string): string | null {
  const b = basename.trim()
  if (!b || b === '.' || b === '..') return null
  if (b.includes('/') || b.includes('\\')) return null
  if (b.includes('\0')) return null
  if (WINDOWS_RESERVED.test(b)) return null
  return b
}

/** 从 LLM 路径参数提取文件名（统一 `/`，兼容 Windows 反斜杠输入在 POSIX 上解析） */
function basenameFromInput(rawPath: string): string {
  return path.posix.basename(normalizeRelPathInput(rawPath))
}

function extOf(filePath: string): string {
  return path.posix.extname(normalizeRelPathInput(filePath)).slice(1).toLowerCase()
}

function lookupSubdir(map: WorkspaceLayoutConfig['extensionSubdirMap'], ext: string): string {
  if (!ext) return ''
  for (const e of map) {
    if (e.extension && e.extension.toLowerCase() === ext) return e.subdir
  }
  return ''
}

/** 输入路径是否含 `..` 段（规范化后判断，兼容 Windows 反斜杠） */
function inputHasTraversal(rawPath: string): boolean {
  return normalizeRelPathInput(rawPath)
    .split('/')
    .some((seg) => seg === '..')
}

/**
 * 决定本次重定向使用的写入目录。
 * - 已有 writeDirChoice：直接用；
 * - 无且未启用确认：兜底为 workDir（调用方在 confirmEnabled=false 时使用）。
 */
export function resolveWriteDirBase(
  writeDirChoice: { dir: string } | null,
  workDir?: string
): string | null {
  if (writeDirChoice?.dir) return writeDirChoice.dir
  return workDir ?? null
}

/**
 * 计算规范重定向结果。不修改 input（由调用方写回 input.path）。
 * 调用前须保证 writeDirChoice 非空（writeDirConfirmEnabled=false 时由调用方填 workDir）。
 */
export async function applyWorkspaceLayoutRedirect(args: RedirectArgs): Promise<RedirectOutcome> {
  const { toolName, input, workDir, workspaceLayout, writeDirChoice } = args
  if (!workspaceLayout.enabled) return { redirected: false }
  if (toolName !== 'write_file') return { redirected: false }
  if (!writeDirChoice) return { redirected: false }

  const rawPath = typeof input.path === 'string' ? input.path : ''
  if (!rawPath.trim()) return { redirected: false }

  let existingAbs = ''
  try {
    existingAbs = await resolveSafePathReal(workDir, rawPath)
    const st = await fs.stat(existingAbs)
    if (st.isFile()) return { redirected: false }
  } catch {
    // LLM 给的路径解析失败或文件不存在，继续按 basename 重定向
  }

  const basename = basenameFromInput(rawPath)
  const safe = sanitizeBasename(basename)
  if (!safe) {
    return {
      redirected: false,
      reject: true,
      rejectReason: `文件名「${basename}」不合法，无法按目录规范写入`
    }
  }

  const ext = extOf(rawPath)
  const subdir = lookupSubdir(workspaceLayout.extensionSubdirMap, ext)

  const canonicalAbs = resolveSafePath(writeDirChoice.dir, subdir ? path.join(subdir, safe) : safe)
  const relToWorkDir = path.relative(path.resolve(workDir), canonicalAbs)
  const normalizedNew = normalizeRelPathInput(relToWorkDir)
  const normalizedRaw = normalizeRelPathInput(rawPath)

  if (!inputHasTraversal(rawPath) && normalizedNew === normalizedRaw) {
    return { redirected: false }
  }

  return {
    redirected: true,
    newPath: normalizedNew,
    originalPath: rawPath,
    reason: `已按目录规范重定向: ${rawPath} → ${normalizedNew}`
  }
}
