import { getDbConnection, type AppDatabase } from '../database/sqliteStore'

/**
 * wiki_projects 表 CRUD（wiki-shared-centralized-storage §6.2）。
 *
 * work_dir 为规范化后的 workDir 绝对路径（canonical：realpath，回退 win32 小写 + 统一分隔符；
 * 规范化由调用方 wikiProjects.ts 完成，本层按字符串精确 UNIQUE）。
 */
export interface WikiProjectRow {
  projectId: string
  workDir: string
  displayName: string
  profileId?: string
  firstSeenAt: number
  orphan: boolean
}

export interface WikiProjectInsertInput {
  projectId: string
  workDir: string
  displayName: string
  profileId?: string
  firstSeenAt?: number
  /** P1-8：裸登记（ingest）不覆盖既有 display_name（§6.2 规则 1 的 profile 名优先级更高） */
  preserveExistingDisplayName?: boolean
}

interface WikiProjectRowRaw {
  project_id: string
  work_dir: string
  display_name: string
  profile_id: string | null
  first_seen_at: number
  orphan: number
}

function toRow(raw: WikiProjectRowRaw): WikiProjectRow {
  return {
    projectId: raw.project_id,
    workDir: raw.work_dir,
    displayName: raw.display_name,
    profileId: raw.profile_id ?? undefined,
    firstSeenAt: raw.first_seen_at,
    orphan: raw.orphan === 1
  }
}

/** 登记项目：同 workDir 幂等收敛为同一行（UNIQUE），展示元数据取最近一次登记，复活时清 orphan。 */
export function insertWikiProject(db: AppDatabase, input: WikiProjectInsertInput): void {
  const conn = getDbConnection(db)
  conn
    .prepare(
      `INSERT INTO wiki_projects (project_id, work_dir, display_name, profile_id, first_seen_at, orphan)
       VALUES (@projectId, @workDir, @displayName, @profileId, @firstSeenAt, 0)
       ON CONFLICT(work_dir) DO UPDATE SET
         display_name = CASE WHEN @preserveDisplayName THEN wiki_projects.display_name ELSE excluded.display_name END,
         profile_id = CASE WHEN @preserveDisplayName THEN wiki_projects.profile_id ELSE excluded.profile_id END,
         orphan = 0`
    )
    .run({
      projectId: input.projectId,
      workDir: input.workDir,
      displayName: input.displayName,
      profileId: input.profileId ?? null,
      firstSeenAt: input.firstSeenAt ?? Date.now(),
      preserveDisplayName: input.preserveExistingDisplayName ? 1 : 0
    })
}

export function getWikiProjectByWorkDir(db: AppDatabase, workDir: string): WikiProjectRow | undefined {
  const conn = getDbConnection(db)
  const raw = conn.prepare('SELECT * FROM wiki_projects WHERE work_dir = ?').get(workDir) as
    | WikiProjectRowRaw
    | undefined
  return raw ? toRow(raw) : undefined
}

export function markWikiProjectOrphan(db: AppDatabase, projectId: string, orphan: boolean): void {
  const conn = getDbConnection(db)
  conn.prepare('UPDATE wiki_projects SET orphan = ? WHERE project_id = ?').run(orphan ? 1 : 0, projectId)
}

export function updateWikiProjectDisplayName(db: AppDatabase, projectId: string, displayName: string): void {
  const conn = getDbConnection(db)
  conn.prepare('UPDATE wiki_projects SET display_name = ? WHERE project_id = ?').run(displayName, projectId)
}

export function listWikiProjects(db: AppDatabase): WikiProjectRow[] {
  const conn = getDbConnection(db)
  const rows = conn.prepare('SELECT * FROM wiki_projects ORDER BY first_seen_at ASC, project_id ASC').all() as unknown as WikiProjectRowRaw[]
  return rows.map(toRow)
}
