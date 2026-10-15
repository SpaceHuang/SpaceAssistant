import type { WikiMigrationReport, WikiProjectSummary } from '../../../shared/domainTypes'

/**
 * T2.5：WikiPane 迁移 UI 的纯逻辑（改名映射 / 项目显示名）。
 */

/** 改名映射查询（§12.3）：命中返回新词汇路径；未命中返回 null（展示通用读取失败提示）。 */
export function resolveMigratedLink(
  renames: Array<{ from: string; to: string }> | undefined,
  relPath: string
): string | null {
  if (!renames || renames.length === 0) return null
  const normalized = relPath.replace(/\\/g, '/')
  const hit = renames.find((r) => r.from === normalized)
  return hit ? hit.to : null
}

export interface ProjectDisplayInfo {
  displayName: string
  workDir: string
  orphan: boolean
}

/** raw 节点展示名映射（v1.12：数据源 wiki:status.projects；tooltip 常驻完整路径）。 */
export function projectDisplayMap(projects: WikiProjectSummary[] | undefined): Map<string, ProjectDisplayInfo> {
  const map = new Map<string, ProjectDisplayInfo>()
  for (const p of projects ?? []) {
    map.set(p.projectId, { displayName: p.displayName, workDir: p.workDir, orphan: p.orphan })
  }
  return map
}

/** 迁移报告摘要（向导完成态展示）。 */
export function summarizeMigrationReport(report: WikiMigrationReport | undefined): {
  migrated: number
  conflicts: number
  renames: number
} {
  return {
    migrated: report?.profiles?.filter((p) => p.status === 'migrated').length ?? 0,
    conflicts: report?.conflicts?.length ?? 0,
    renames: report?.renames?.length ?? 0
  }
}
