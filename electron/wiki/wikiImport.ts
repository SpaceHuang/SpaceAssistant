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
import { createWikiFileStore } from './wikiFileStore'
import { randomUUID } from 'node:crypto'
import { createWikiLifecycleController } from './wikiLifecycle'

export type WikiImportRawResult =
  | { ok: true; rawRelPath: string; copied: boolean; sourceId?: string; sourceRevision?: number }
  | { ok: false; error: string }

export type WikiImportAllRawResult =
  | { ok: true; sources: Array<{ sourceId: string; sourceRevision: number; displayName: string }>; remainingCount: number }
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

/** Host-only bulk selection: enumerate regular Markdown/text files under workDir, never follow symlinks. */
export async function importAllRawFromWorkDir(
  workDir: string,
  wikiConfig: WikiConfig,
  shared: WikiImportSharedOptions
): Promise<WikiImportAllRawResult> {
  const supported = new Set(['.md', '.markdown', '.txt'])
  const excluded = new Set(['.git', '.worktrees', 'node_modules', 'dist', 'build', 'target'])
  const candidates: string[] = []
  const pending = ['']
  try {
    while (pending.length) {
      const relative = pending.pop()!
      const absolute = resolveSafePath(workDir, relative || '.')
      const entries = await fs.readdir(absolute, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.') || excluded.has(entry.name)) continue
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (entry.name !== wikiConfig.rootPath) pending.push(child)
          continue
        }
        if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) candidates.push(child)
      }
      if (candidates.length > 250) return { ok: false, error: '可导入文本超过 250 个，请改用单文件 ingest' }
    }
    candidates.sort((a, b) => a.localeCompare(b, 'zh-CN'))
    const maxBatch = Number.isSafeInteger(wikiConfig.maxBatchIngest) ? Math.max(1, Math.min(250, wikiConfig.maxBatchIngest)) : 10
    const remainingCount = Math.max(0, candidates.length - maxBatch)
    candidates.splice(maxBatch)
    const sources: Array<{ sourceId: string; sourceRevision: number; displayName: string }> = []
    let totalBytes = 0
    for (const srcRelPath of candidates) {
      const absolute = resolveSafePath(workDir, srcRelPath)
      const stat = await fs.stat(absolute)
      const metadata = await getFileMetadata(absolute)
      if (!metadata.isText || stat.size > 10 * 1024 * 1024) return { ok: false, error: `${srcRelPath}: 仅支持 10 MiB 内的文本资料` }
      totalBytes += stat.size
      if (totalBytes > 50 * 1024 * 1024) return { ok: false, error: '可导入文本总量超过 50 MiB，请改用单文件 ingest' }
    }
    for (const srcRelPath of candidates) {
      const result = await importRawFromWorkDir(workDir, wikiConfig, srcRelPath, shared)
      if (!result.ok) return { ok: false, error: `${srcRelPath}: ${result.error}` }
      if (!result.sourceId || !result.sourceRevision) return { ok: false, error: `${srcRelPath}: 来源绑定未完成` }
      sources.push({ sourceId: result.sourceId, sourceRevision: result.sourceRevision, displayName: path.basename(srcRelPath) })
    }
    return { ok: true, sources, remainingCount }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}


/** T1.12c：ingest 落共享根 raw/<projectId>/，落盘经 realBase 沙箱 + wikiWriteMutex（§9.4）。 */
async function importRawToSharedRoot(
  workDir: string,
  wikiConfig: WikiConfig,
  srcRelPath: string,
  shared: WikiImportSharedOptions
): Promise<WikiImportRawResult> {
  const realBase = resolveSharedWikiRoot(shared.userDataPath!, wikiConfig)
  return withWikiWriteMutex(path.join(realBase, '.wiki-domain-lock'), async () => {
    const lifecycle = await createWikiLifecycleController(realBase).read()
    if (lifecycle.lifecycle !== 'domain_enabled') {
      return { ok: false, error: `Wiki lifecycle blocks import: ${lifecycle.lifecycle}` }
    }
    return importRawToSharedRootUnderLock(workDir, wikiConfig, srcRelPath, shared, realBase)
  })
}

async function importRawToSharedRootUnderLock(
  workDir: string,
  wikiConfig: WikiConfig,
  srcRelPath: string,
  shared: WikiImportSharedOptions,
  realBase: string
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

  if (kind === 'raw') {
    const relative = normalized.startsWith(`${WIKI_VOCABULARY_PREFIX}/`) ? normalized.slice(WIKI_VOCABULARY_PREFIX.length + 1) : normalized
    try {
      const sourceAbs = resolveSafePath(realBase, relative)
      const stat = await fs.stat(sourceAbs)
      if (stat.isDirectory()) return { ok: false, error: '目录不能收录到 Wiki' }
      const meta = await getFileMetadata(sourceAbs)
      if (!meta.isText) return { ok: false, error: '首版仅支持文本资料（.md / .txt）' }
      const projectId = relative.split('/')[1] || computeProjectId(workDir)
      const rawRelPath = `${WIKI_VOCABULARY_PREFIX}/${relative}`
      const source = await registerSourceBinding(realBase, sourceAbs, relative, projectId)
      return { ok: true, rawRelPath, copied: false, sourceId: source.sourceId, sourceRevision: source.sourceRevision }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
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
      const bytes = await fs.readFile(srcAbs)
      await createWikiFileStore(realBase).write(rawRelInRoot, bytes, null)
      return dest
    })
    const finalRel = path.relative(realBase, destAbs).replace(/\\/g, '/')
    // 复审残余（BLK-4 延伸）：词汇前缀恒为常量——rootPath 改名后 my-lib/raw/... 不可挂载
    const rawRelPath = `${WIKI_VOCABULARY_PREFIX}/${finalRel}`
    const source = await registerSourceBinding(realBase, destAbs, finalRel, projectId)
    return { ok: true, rawRelPath, copied: true, sourceId: source.sourceId, sourceRevision: source.sourceRevision }
  } catch (e) {
    if (e instanceof Error && e.message === '无法生成 raw 目标路径') return { ok: false, error: e.message }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function registerSourceBinding(root: string, sourcePath: string, relativePath: string, projectId: string): Promise<{ sourceId: string; sourceRevision: number }> {
  const bytes = await fs.readFile(sourcePath)
  if (bytes.length > 10 * 1024 * 1024 || bytes.includes(0)) throw new Error('首版仅支持 10 MiB 内的文本资料')
  const sourceId = randomUUID()
  const sourceRevision = 1
  const store = createWikiFileStore(root)
  await store.writeImmutable(`.wiki-service/source-history/${sourceId}/${sourceRevision}.md`, bytes)
  await store.write(`.wiki-service/sources/${sourceId}.json`, `${JSON.stringify({ formatVersion: 1, sourceId, sourceRevision, displayName: path.basename(relativePath), projectId, rawPath: relativePath }, null, 2)}\n`)
  return { sourceId, sourceRevision }
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
