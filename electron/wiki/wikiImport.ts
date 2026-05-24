import fs from 'fs/promises'
import path from 'path'
import type { WikiConfig } from '../../src/shared/domainTypes'
import {
  autoRenameRawPath,
  classifyWikiCollectPath,
  computeRawDestBasename,
  normalizeRelPath
} from '../../src/shared/wikiImportPaths'
import { resolveSafePath } from '../pathSecurity'
import { getFileMetadata } from '../fileReadHelpers'

export type WikiImportRawResult =
  | { ok: true; rawRelPath: string; copied: boolean }
  | { ok: false; error: string }

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}

async function resolveAvailableRawPath(workDir: string, baseRawRelPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? baseRawRelPath : autoRenameRawPath(baseRawRelPath, attempt - 1)
    const abs = resolveSafePath(workDir, candidate)
    if (!(await pathExists(abs))) return candidate
  }
  return null
}

export async function importRawFromWorkDir(
  workDir: string,
  wikiConfig: WikiConfig,
  srcRelPath: string
): Promise<WikiImportRawResult> {
  if (!wikiConfig.enabled) return { ok: false, error: 'Wiki 功能未启用，请先在设置中开启' }

  const normalized = normalizeRelPath(srcRelPath)
  if (!normalized) return { ok: false, error: '路径无效' }

  const kind = classifyWikiCollectPath(normalized, wikiConfig.rootPath)
  if (kind === 'wiki-page') {
    return { ok: false, error: 'Wiki 页面不能作为 Ingest 源；请使用对应 raw 文件或归档' }
  }
  if (kind === 'schema' || kind === 'wiki-other') {
    return { ok: false, error: '该路径不能收录到 Wiki' }
  }

  let srcAbs: string
  try {
    srcAbs = resolveSafePath(workDir, normalized)
    const stat = await fs.stat(srcAbs)
    if (stat.isDirectory()) return { ok: false, error: '目录不能收录到 Wiki' }
    const meta = await getFileMetadata(srcAbs)
    if (!meta.isText) return { ok: false, error: '首版仅支持文本资料（.md / .txt）' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  if (kind === 'raw') {
    return { ok: true, rawRelPath: normalized, copied: false }
  }

  const baseRawRelPath = computeRawDestBasename(normalized, wikiConfig.rootPath)
  const rawRelPath = await resolveAvailableRawPath(workDir, baseRawRelPath)
  if (!rawRelPath) return { ok: false, error: '无法生成 raw 目标路径' }

  try {
    const destAbs = resolveSafePath(workDir, rawRelPath)
    await fs.mkdir(path.dirname(destAbs), { recursive: true })
    await fs.copyFile(srcAbs, destAbs)
    return { ok: true, rawRelPath, copied: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function copyFileInWorkDir(
  workDir: string,
  srcRelPath: string,
  destRelPath: string
): Promise<void> {
  const srcAbs = resolveSafePath(workDir, normalizeRelPath(srcRelPath))
  const destAbs = resolveSafePath(workDir, normalizeRelPath(destRelPath))
  await fs.mkdir(path.dirname(destAbs), { recursive: true })
  await fs.copyFile(srcAbs, destAbs)
}
