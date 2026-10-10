import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { AppDatabase } from '../database/sqliteStore'
import { insertWikiProject, listWikiProjects, updateWikiProjectDisplayName } from './wikiProjectStore'

/**
 * projectId / display_name / wiki_projects 登记（§6.2）。
 * projectId 一律取规范化 workDir 绝对路径的哈希 p-<sha8>——不使用 profileId：
 * 两个 profile 可指向同一目录（profileId 不同、workDir 相同），哈希方案下同一目录天然收敛。
 */

/** 规范化（§6.2）：realpath 后 win32 小写化（Node realpath 在 win32 保留输入大小写，实测）；回退 win32 小写 + 统一分隔符。 */
export function canonicalWorkDir(workDir: string): string {
  let resolved = workDir
  try {
    resolved = fs.realpathSync(workDir)
  } catch {
    resolved = workDir.replace(/\//g, '\\')
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function computeProjectId(workDir: string): string {
  return `p-${createHash('sha256').update(canonicalWorkDir(workDir)).digest('hex').slice(0, 8)}`
}

/** 展示名用：从原始输入解析末段目录名（保留大小写；仅统一分隔符）。 */
function displayBasenameOf(workDir: string): string {
  const trimmed = workDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** 展示名消歧用：一级父目录名（保留大小写）。 */
function displayParentBasenameOf(workDir: string): string {
  const trimmed = workDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return ''
  const parent = trimmed.slice(0, idx)
  const pidx = parent.lastIndexOf('/')
  return pidx >= 0 ? parent.slice(pidx + 1) : parent
}

/**
 * display_name 取名规则（§6.2，已决议）：
 * 1. workDir 关联 profile → 用 profile 名；
 * 2. 裸 workDir → basename；
 * 3. 多个 workDir basename 相同 → 追加一级父目录消歧（需 db 查既有行）；
 * 4. tooltip 常驻完整路径（由 UI 层承担）。
 */
export function computeDisplayName(workDir: string, profileName?: string, db?: AppDatabase): string {
  if (profileName && profileName.trim()) return profileName.trim()
  const base = displayBasenameOf(workDir)
  if (db) {
    const canonical = canonicalWorkDir(workDir)
    const clash = listWikiProjects(db).some((row) => row.displayName === base && row.workDir !== canonical)
    if (clash) {
      const parent = displayParentBasenameOf(workDir)
      if (parent) return `${parent}/${base}`
    }
  }
  return base
}

export interface WikiProjectRegistration {
  projectId: string
  displayName: string
}

/** 登记项目（ingest / 状态查询时由主进程调用）：projectId 按目录哈希，同目录幂等收敛。 */
export function registerWikiProject(
  db: AppDatabase,
  input: { workDir: string; profileId?: string; profileName?: string; preserveExistingDisplayName?: boolean }
): WikiProjectRegistration {
  const projectId = computeProjectId(input.workDir)
  const canonical = canonicalWorkDir(input.workDir)
  const displayName = computeDisplayName(input.workDir, input.profileName, db)
  insertWikiProject(db, { projectId, workDir: canonical, displayName, profileId: input.profileId, preserveExistingDisplayName: input.preserveExistingDisplayName })
  // 登记后二次消歧：新行与既有行 basename 撞名（本行 insert 后才可见的冲突）→ 更新本行
  if (!input.profileName) {
    const rows = listWikiProjects(db)
    const clash = rows.some((row) => row.displayName === displayName && row.workDir !== canonical)
    if (clash) {
      const parent = displayParentBasenameOf(input.workDir)
      if (parent) {
        const disambiguated = `${parent}/${displayName}`
        updateWikiProjectDisplayName(db, projectId, disambiguated)
        return { projectId, displayName: disambiguated }
      }
    }
  }
  return { projectId, displayName }
}
