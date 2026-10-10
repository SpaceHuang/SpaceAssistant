import type { FileTreeChangeEvent } from '../../src/shared/fileTreeSync'
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
import { registerWikiProject, computeProjectId } from './wikiProjects'
import { resolveSharedWikiRoot } from './wikiInit'
import { WIKI_VOCABULARY_PREFIX } from '../../src/shared/wikiConstants'
import { withWikiWriteMutex } from './wikiWriteMutex'
import type { AppDatabase } from '../database/sqliteStore'

export type WikiImportRawResult =
  | { ok: true; rawRelPath: string; copied: boolean }
  | { ok: false; error: string }

export function wikiImportFileTreeChange(result: WikiImportRawResult): FileTreeChangeEvent | null {
  if (result.ok && result.copied) {
    return { kind: 'paths', relPaths: [result.rawRelPath] }
  }
  return null
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}

async function resolveAvailableRawPath(sandboxRoot: string, baseRawRelPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? baseRawRelPath : autoRenameRawPath(baseRawRelPath, attempt - 1)
    const abs = resolveSafePath(sandboxRoot, candidate)
    if (!(await pathExists(abs))) return candidate
  }
  return null
}

export interface WikiImportSharedOptions {
  /** 共享库 userData 目录（T1.12c：传入时 ingest 落 {userData}/<rootPath>/raw/<projectId>/） */
  userDataPath?: string
  /** wiki_projects 登记与 projectId 计算 */
  db?: AppDatabase
}

export async function importRawFromWorkDir(
  workDir: string,
  wikiConfig: WikiConfig,
  srcRelPath: string,
  shared?: WikiImportSharedOptions
): Promise<WikiImportRawResult> {
  if (!wikiConfig.enabled) return { ok: false, error: 'Wiki 功能未启用，请先在设置中开启' }
  if (shared?.userDataPath) return importRawToSharedRoot(workDir, wikiConfig, srcRelPath, shared)

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


/** T1.12c：ingest 落共享根 raw/<projectId>/，落盘经 realBase 沙箱 + wikiWriteMutex（§9.4）。 */
async function importRawToSharedRoot(
  workDir: string,
  wikiConfig: WikiConfig,
  srcRelPath: string,
  shared: WikiImportSharedOptions
): Promise<WikiImportRawResult> {
  const normalized = normalizeRelPath(srcRelPath)
  if (!normalized) return { ok: false, error: '路径无效' }

  const kind = classifyWikiCollectPath(normalized, wikiConfig.rootPath)
  if (kind === 'wiki-page') {
    return { ok: false, error: 'Wiki 页面不能作为 Ingest 源；请使用对应 raw 文件或归档' }
  }
  if (kind === 'schema' || kind === 'wiki-other') {
    return { ok: false, error: '该路径不能收录到 Wiki' }
  }

  const userDataPath = shared.userDataPath!
  const realBase = resolveSharedWikiRoot(userDataPath, wikiConfig)

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
    // 已在共享库 raw/ 内的显式路径：返回词汇形态
    return { ok: true, rawRelPath: normalized, copied: false }
  }

  // 项目登记（projectId = workDir 哈希；同目录幂等收敛）
  let projectId: string
  if (shared.db) {
    // P1-8：ingest 为裸登记——不覆盖既有 display_name/profile_id（§6.2 规则 1 profile 名优先）
    projectId = registerWikiProject(shared.db, { workDir, preserveExistingDisplayName: true }).projectId
  } else {
    projectId = computeProjectId(workDir)
  }

  const basename = normalized.split('/').filter(Boolean).pop() || 'untitled'
  const baseRawRelInRoot = `raw/${projectId}/${basename}`
  try {
    // P1-7（§9.4）：选名与拷贝整体在互斥区内——并发同名 ingest 不再互相覆盖
    const destAbs = await withWikiWriteMutex(path.join(realBase, baseRawRelInRoot), async () => {
      const rawRelInRoot = await resolveAvailableRawPath(realBase, baseRawRelInRoot)
      if (!rawRelInRoot) throw new Error('无法生成 raw 目标路径')
      const dest = resolveSafePath(realBase, rawRelInRoot)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.copyFile(srcAbs, dest)
      return dest
    })
    const finalRel = path.relative(realBase, destAbs).replace(/\\/g, '/')
    const rawRelPath = `${wikiConfig.rootPath || WIKI_VOCABULARY_PREFIX}/${finalRel}`
    return { ok: true, rawRelPath, copied: true }
  } catch (e) {
    if (e instanceof Error && e.message === '无法生成 raw 目标路径') return { ok: false, error: e.message }
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
