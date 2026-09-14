import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  GithubInstallResult,
  GithubSkillCandidate,
  GithubSkillProbeResult,
  SkillDefinition,
  SkillMeta,
  SkippedCandidate
} from '../../src/shared/domainTypes'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { installSkillToUserDir } from './skillInstall'
import { getUserSkillsDir } from './skillPaths'
import { computeSkillDirSize, validateSkillSourceDir } from './skillParser'
import {
  buildGithubArchiveExtractMembers,
  downloadGithubArchive,
  githubArchiveRootFolder,
  validateTarListing
} from './skillGithubArchive'

/** 归档相关的纯函数保持从本模块导出，兼容既有引用 */
export { buildGithubArchiveExtractMembers, githubArchiveRootFolder, validateTarListing }

export type ParsedGithubSource = {
  owner: string
  repo: string
  branch: string
  subPath: string
}

export type DiscoveryResult = {
  dirs: string[]
  /** true = 候选数达到 MAX_CANDIDATES 被截断 */
  truncated: boolean
  /** true = 目录访问数达到 MAX_VISITED_DIRS 被截断 */
  visitedTruncated: boolean
}

/** 自搜索根起算最多下探的目录层数：searchRoot/a/b/c/SKILL.md 是最深可达形态 */
export const MAX_DISCOVERY_DEPTH = 3
export const MAX_CANDIDATES = 100
export const MAX_VISITED_DIRS = 2000

/** 容器目录名：只匹配字面 skills/（大小写跟随宿主文件系统语义，见需求 §5.4 R4） */
const SKILLS_CONTAINER_NAME = 'skills'

/** R1 显式忽略目录；通用规则为「忽略所有以 . 开头的目录」（见 isIgnoredDirName） */
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  '__pycache__',
  'venv',
  'target'
])

export function isIgnoredDirName(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIR_NAMES.has(name)
}

const GITHUB_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/(.+?)(?:\/(.+))?)?\/?$/i

export function parseGithubSkillUrl(url: string): ParsedGithubSource | null {
  const trimmed = url.trim().split(/[?#]/, 1)[0].replace(/\/$/, '')
  if (/^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/blob\//i.test(trimmed)) return null
  const match = trimmed.match(GITHUB_URL_RE)
  if (!match) return null
  if (match[4]?.includes('..')) return null
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
    branch: match[3] || 'main',
    subPath: match[4] ? decodeURIComponent(match[4]) : ''
  }
}

function readDirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * SKILL.md 采用大小写敏感的精确名匹配：readdir 的条目名比较不依赖宿主文件系统的大小写语义，
 * 避免在 Windows / macOS 上把小写 skill.md 误判为 Skill（Linux 上本就不命中）。
 */
function hasSkillMd(dir: string, entries?: fs.Dirent[]): boolean {
  const list = entries ?? readDirEntries(dir)
  return list.some((ent) => !ent.isDirectory() && ent.name === 'SKILL.md')
}

function toRelativePath(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/')
}

/** 层级升序 → 同层级按相对路径字典序（保证同一目录树多次探测结果完全一致） */
function sortDiscoveredDirs(dirs: string[], searchRoot: string): string[] {
  return [...dirs].sort((a, b) => {
    const relA = toRelativePath(searchRoot, a)
    const relB = toRelativePath(searchRoot, b)
    const depthA = relA.split('/').length
    const depthB = relB.split('/').length
    if (depthA !== depthB) return depthA - depthB
    return relA < relB ? -1 : relA > relB ? 1 : 0
  })
}

/** 有界广度优先搜索；命中即剪枝（R2），忽略目录不进入也不作为候选（R1） */
function boundedBfs(searchRoot: string, options: { exclude?: string[] } = {}): DiscoveryResult {
  const excludeSet = new Set((options.exclude ?? []).map((dir) => path.resolve(dir)))
  const dirs: string[] = []
  let truncated = false
  let visitedTruncated = false
  let visited = 0

  const queue: Array<{ dir: string; depth: number; entries: fs.Dirent[] }> = [
    { dir: searchRoot, depth: 0, entries: readDirEntries(searchRoot) }
  ]
  let cursor = 0

  while (cursor < queue.length) {
    const current = queue[cursor++]
    visited += 1
    if (visited > MAX_VISITED_DIRS) {
      visitedTruncated = true
      break
    }

    const children = current.entries
      .filter((ent) => ent.isDirectory() && !isIgnoredDirName(ent.name))
      .map((ent) => path.join(current.dir, ent.name))
      .filter((child) => !excludeSet.has(path.resolve(child)))
      .sort((a, b) => {
        const nameA = path.basename(a)
        const nameB = path.basename(b)
        return nameA < nameB ? -1 : nameA > nameB ? 1 : 0
      })

    for (const child of children) {
      const childEntries = readDirEntries(child)
      if (hasSkillMd(child, childEntries)) {
        dirs.push(child)
        if (dirs.length > MAX_CANDIDATES) {
          dirs.pop()
          truncated = true
          return { dirs: sortDiscoveredDirs(dirs, searchRoot), truncated, visitedTruncated }
        }
        continue
      }
      if (current.depth + 1 < MAX_DISCOVERY_DEPTH) {
        queue.push({ dir: child, depth: current.depth + 1, entries: childEntries })
      }
    }
  }

  return { dirs: sortDiscoveredDirs(dirs, searchRoot), truncated, visitedTruncated }
}

function describeSearchScope(baseLabel: string, foundContainer: boolean): string {
  const scope = baseLabel + ' 下 ' + MAX_DISCOVERY_DEPTH + ' 层子目录'
  if (!foundContainer) return '已查找：' + scope
  return '已查找：' + SKILLS_CONTAINER_NAME + '/ 目录（无命中）与 ' + scope
}

/**
 * 目录发现：容器优先 + 有界 BFS（需求 §5.2）。
 * 容器 skills/ 内有命中时不再回落（R3），以排除 template/ 这类根目录散落物。
 */
export function discoverSkillDirs(
  extractedRepoRoot: string,
  subPath: string,
  installAll: boolean
): DiscoveryResult {
  const base = subPath ? path.join(extractedRepoRoot, ...subPath.split('/')) : extractedRepoRoot
  const baseLabel = subPath ? '`' + subPath + '`' : '仓库根目录'
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error('SKILL_PATH_NOT_FOUND: 仓库中未找到目录：' + (subPath || '根目录'))
  }

  if (hasSkillMd(base)) {
    return { dirs: [base], truncated: false, visitedTruncated: false }
  }

  if (!installAll) {
    throw new Error('SKILL_NOT_FOUND_IN_REPO: ' + baseLabel + '不是有效的 Skill 目录（未找到 SKILL.md）')
  }

  const containerPath = path.join(base, SKILLS_CONTAINER_NAME)
  let containerIsDir = false
  try {
    containerIsDir = fs.statSync(containerPath).isDirectory()
  } catch {
    containerIsDir = false
  }

  if (containerIsDir) {
    const containerResult = boundedBfs(containerPath)
    if (containerResult.dirs.length > 0) return containerResult
  }

  const result = boundedBfs(base, containerIsDir ? { exclude: [containerPath] } : {})
  if (result.dirs.length === 0) {
    throw new Error('SKILL_NOT_FOUND_IN_REPO: ' + describeSearchScope(baseLabel, containerIsDir))
  }
  return result
}

function rmDirSafe(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

export type GithubInstallOptions = {
  subPath?: string
  /** 批量多选：一次下载 + 一次解压，逐候选独立定位/校验/判定冲突（B-3） */
  subPaths?: string[]
  installAll?: boolean
  overwrite?: boolean
  onProgress?: (progress: { phase: string; completed?: number; total?: number }) => void
  signal?: AbortSignal
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeDirSize(dir: string): number {
  try {
    return computeSkillDirSize(dir).totalBytes
  } catch {
    return 0
  }
}

function nameConflictReason(name: string): string {
  return `SKILL_NAME_CONFLICT: 用户级目录下已存在 Skill「${name}」`
}

/**
 * 校验批量候选子路径（新增 IPC 入参，不经过 parseGithubSkillUrl 的 URL 语义）：
 * 必须是非空相对路径、不含 `..` 段、不含绝对路径 / 盘符 / 反斜杠；重复项去重。
 * 不合法整体拒绝（SKILL_URL_INVALID），不静默丢弃。
 */
function normalizeSubPaths(raw: string[]): string[] {
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('SKILL_URL_INVALID: 候选子路径必须是字符串')
    const segments = item.split('/')
    const unsafe =
      item.trim() === '' ||
      item.includes('\\') ||
      /^[a-zA-Z]:/.test(item) ||
      path.posix.isAbsolute(item) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    if (unsafe) throw new Error('SKILL_URL_INVALID: 候选子路径不合法：' + item)
    if (seen.has(item)) continue
    seen.add(item)
    deduped.push(item)
  }
  if (deduped.length > MAX_CANDIDATES) {
    throw new Error('SKILL_URL_INVALID: 候选数量超过 ' + MAX_CANDIDATES + ' 上限')
  }
  return deduped
}

export async function installSkillsFromGithub(
  userDataPath: string,
  sourceUrl: string,
  options: GithubInstallOptions = {}
): Promise<GithubInstallResult> {
  if (!/^https?:\/\/(?:www\.)?github\.com\//i.test(sourceUrl.trim())) throw new Error('SKILL_URL_UNSUPPORTED_HOST: 仅支持 GitHub 地址')
  const parsed = parseGithubSkillUrl(sourceUrl)
  if (!parsed) throw new Error('SKILL_URL_INVALID: 无效的 GitHub 地址（blob 地址请改用目录地址）')

  const subPath = options.subPath ?? parsed.subPath
  const installAll = options.installAll === true
  const overwrite = options.overwrite === true
  const batchSubPaths = Array.isArray(options.subPaths) && options.subPaths.length > 0 ? normalizeSubPaths(options.subPaths) : null
  if (batchSubPaths && options.subPath) {
    logAgentEvent('warn', 'skills.install.sub_paths_override', {
      reason: 'subPaths 优先于 subPath',
      subPath: options.subPath,
      subPaths: batchSubPaths
    })
  }
  // 降级语义只作用于批量路径（subPaths / installAll）；显式单目标维持整体抛错（B-1、B-3）
  const degrade = Boolean(batchSubPaths) || installAll
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-github-'))

  try {
    const extractedRepoRoot = await downloadGithubArchive(
      parsed.owner,
      parsed.repo,
      parsed.branch,
      tempRoot,
      batchSubPaths ? undefined : subPath || undefined,
      options.onProgress,
      options.signal
    )

    const candidates: Array<{ subPath: string; sourceDir: string | null }> = []
    if (batchSubPaths) {
      for (const candidate of batchSubPaths) {
        const dir = path.join(extractedRepoRoot, ...candidate.split('/'))
        let located = false
        try {
          located = fs.statSync(dir).isDirectory()
        } catch {
          located = false
        }
        candidates.push({ subPath: candidate, sourceDir: located ? dir : null })
      }
    } else {
      for (const dir of discoverSkillDirs(extractedRepoRoot, subPath, installAll).dirs) {
        candidates.push({ subPath: toRelativePath(extractedRepoRoot, dir), sourceDir: dir })
      }
    }

    const skipped: SkippedCandidate[] = []
    const installable: Array<{ sourceDir: string; subPath: string; name: string }> = []
    const total = candidates.length
    let completed = 0

    for (const candidate of candidates) {
      if (!candidate.sourceDir) {
        skipped.push({ subPath: candidate.subPath, reason: 'SKILL_PATH_NOT_FOUND: 仓库中未找到目录：' + candidate.subPath })
        completed += 1
        continue
      }
      let meta: SkillMeta
      try {
        meta = validateSkillSourceDir(candidate.sourceDir).meta
      } catch (error) {
        if (!degrade) throw error
        skipped.push({ subPath: candidate.subPath, name: path.basename(candidate.sourceDir), reason: messageOf(error) })
        completed += 1
        continue
      }
      const targetDir = path.join(getUserSkillsDir(userDataPath), meta.name)
      if (!overwrite && fs.existsSync(targetDir)) {
        if (!degrade) throw new Error(nameConflictReason(meta.name))
        skipped.push({ subPath: candidate.subPath, name: meta.name, reason: nameConflictReason(meta.name) })
        completed += 1
        continue
      }
      installable.push({ sourceDir: candidate.sourceDir, subPath: candidate.subPath, name: meta.name })
    }

    if (installable.length === 0) {
      // 全部同名（overwrite=false）是用户在弹窗里「不勾选同名项」的预期结果，不是错误
      const hasNameConflict = skipped.some((item) => item.reason.startsWith('SKILL_NAME_CONFLICT'))
      if (!hasNameConflict) {
        throw new Error(`SKILL_NO_INSTALLABLE_CANDIDATE: ${total} 个 Skill 目录均无法安装`)
      }
      return { installed: [], skipped, overwritten: [] }
    }

    const installed: SkillDefinition[] = []
    const overwritten: string[] = []
    const createdTargets: string[] = []
    try {
      for (const item of installable) {
        options.onProgress?.({ phase: 'install', completed, total })
        const targetDir = path.join(getUserSkillsDir(userDataPath), item.name)
        const existed = fs.existsSync(targetDir)
        // 来源元数据写入解析后的实际相对路径，保证链接直达该 Skill 目录（缺陷 A）
        installed.push(await installSkillToUserDir(userDataPath, item.sourceDir, overwrite, {
          schemaVersion: 1,
          sourceType: 'github',
          sourceUrl: 'https://github.com/' + parsed.owner + '/' + parsed.repo + (item.subPath ? '/tree/' + parsed.branch + '/' + item.subPath : ''),
          owner: parsed.owner,
          repo: parsed.repo,
          ref: parsed.branch,
          subPath: item.subPath,
          installedAt: new Date().toISOString(),
          appVersion: '0.1.7'
        }))
        createdTargets.push(targetDir)
        if (existed && overwrite) overwritten.push(item.name)
        completed += 1
      }
    } catch (error) {
      if (!overwrite) for (const target of createdTargets) if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
      throw error
    }

    return { installed, skipped, overwritten }
  } finally {
    rmDirSafe(tempRoot)
  }
}

export async function probeGithubSkillUrl(sourceUrl: string, userDataPath?: string): Promise<GithubSkillProbeResult> {
  if (!/^https?:\/\/(?:www\.)?github\.com\//i.test(sourceUrl.trim())) throw new Error('SKILL_URL_UNSUPPORTED_HOST: 仅支持 GitHub 地址')
  const parsed = parseGithubSkillUrl(sourceUrl)
  if (!parsed) throw new Error('SKILL_URL_INVALID: 无效的 GitHub 地址')
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-github-probe-'))
  try {
    const root = await downloadGithubArchive(parsed.owner, parsed.repo, parsed.branch, tempRoot, parsed.subPath || undefined)
    const discovery = discoverSkillDirs(root, parsed.subPath, true)
    const userSkillsDir = userDataPath ? getUserSkillsDir(userDataPath) : null
    const candidates = discovery.dirs.map((dir): GithubSkillCandidate => {
      const subPath = toRelativePath(root, dir)
      try {
        const skill = validateSkillSourceDir(dir)
        const conflict = Boolean(userSkillsDir && fs.existsSync(path.join(userSkillsDir, skill.meta.name)))
        return {
          name: skill.meta.name,
          description: skill.meta.description,
          subPath,
          totalBytes: computeSkillDirSize(dir).totalBytes,
          status: conflict ? 'name-conflict' : 'ok',
          ...(conflict ? { reason: nameConflictReason(skill.meta.name) } : {})
        }
      } catch (error) {
        // 探测永不因单个候选非法而失败（B-1）：保留候选并标记原因
        return {
          name: path.basename(dir),
          description: '',
          subPath,
          totalBytes: safeDirSize(dir),
          status: 'invalid',
          reason: messageOf(error)
        }
      }
    })
    return { repo: parsed, candidates, truncated: discovery.truncated, visitedTruncated: discovery.visitedTruncated }
  } finally {
    rmDirSafe(tempRoot)
  }
}
