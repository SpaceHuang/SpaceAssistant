import fs from 'fs'
import path from 'path'
import type { WikiConfig, WikiStatus, WikiProjectSummary } from '../../src/shared/domainTypes'
import { isWikiInitialized, resolveSharedWikiRoot } from './wikiInit'
import { resolveWikiRootAbs } from './wikiPaths'
import type { AppDatabase } from '../database/sqliteStore'
import { listWikiProjects } from './wikiProjectStore'

function countMarkdownFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let count = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.isFile() && ent.name.endsWith('.md')) count++
    }
  }
  return count
}

function countRawFiles(rawDir: string): number {
  // P1-4：共享结构为 raw/<projectId>/<file>，需递归统计（旧扁平结构同样兼容）
  if (!fs.existsSync(rawDir)) return 0
  let count = 0
  const stack = [rawDir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.isFile()) count++
    }
  }
  return count
}

function readLastLogEntry(logPath: string): string | undefined {
  if (!fs.existsSync(logPath)) return undefined
  const content = fs.readFileSync(logPath, 'utf8')
  const lines = content.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('## [')) return line
  }
  return undefined
}

export function getWikiStatus(
  workDir: string,
  wikiConfig: WikiConfig,
  opts?: { userDataPath?: string; db?: AppDatabase }
): WikiStatus {
  const rootRel = wikiConfig.rootPath.replace(/\\/g, '/').replace(/^\/+/, '')
  // T1.12a：共享库模式（传 userDataPath）读 {userData}/<rootPath>；projects 映射自 wiki_projects 表（v1.12）
  const shared = opts?.userDataPath !== undefined
  const projects: WikiProjectSummary[] | undefined = opts?.db
    ? listWikiProjects(opts.db).map((row) => ({
        projectId: row.projectId,
        displayName: row.displayName,
        workDir: row.workDir,
        orphan: row.orphan
      }))
    : undefined
  const newFields = {
    ...(shared ? { shared: true as const } : {}),
    ...(opts?.db ? { projectCount: projects!.length } : {}),
    ...(projects ? { projects } : {}),
    pendingLegacyMigration: false,
    legacyRoots: [] as string[]
  }
  const initialized = isWikiInitialized(workDir, wikiConfig, opts?.userDataPath)
  if (!initialized) {
    return {
      enabled: wikiConfig.enabled,
      rootPath: rootRel,
      initialized: false,
      pageCount: 0,
      rawCount: 0,
      ...newFields
    }
  }

  const root = opts?.userDataPath ? resolveSharedWikiRoot(opts.userDataPath, wikiConfig) : resolveWikiRootAbs(workDir, wikiConfig)
  const wikiDir = path.join(root, 'wiki')
  const rawDir = path.join(root, 'raw')
  const logPath = path.join(wikiDir, 'log.md')

  return {
    enabled: wikiConfig.enabled,
    rootPath: rootRel,
    initialized: true,
    pageCount: countMarkdownFiles(wikiDir),
    rawCount: countRawFiles(rawDir),
    lastLogEntry: readLastLogEntry(logPath),
    ...newFields
  }
}
