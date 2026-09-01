import fs from 'fs/promises'
import path from 'path'
import type { ExecutionLane, SecurityAuditEvent } from '../../src/shared/confirmation/types'

/** 审计查询过滤条件（设置页第 5 区；均为可选，组合取交集）。 */
export interface SecurityAuditQuery {
  /** 起始时间（含），毫秒时间戳。 */
  since?: number
  /** 截止时间（含），毫秒时间戳。 */
  until?: number
  lane?: ExecutionLane
  /** 事件类型精确匹配（如 'cache.clear' / 'settings.policy-change'）。 */
  event?: string
  toolName?: string
  /** 返回上限（默认 200，倒序取最新）。 */
  limit?: number
}

export const DEFAULT_AUDIT_QUERY_LIMIT = 200
export const MAX_AUDIT_QUERY_LIMIT = 1000

/** 解析 JSON Lines 文本为事件数组；坏行跳过（日志可能截断/半成品行）。 */
export function parseSecurityAuditLines(text: string): SecurityAuditEvent[] {
  const out: SecurityAuditEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const ev = JSON.parse(trimmed) as SecurityAuditEvent
      if (typeof ev.ts === 'number' && typeof ev.event === 'string') out.push(ev)
    } catch {
      /* 跳过坏行 */
    }
  }
  return out
}

/** 过滤 + 倒序（最新在前）+ 截断。纯函数，供单测。 */
export function filterSecurityAuditEvents(
  events: SecurityAuditEvent[],
  query: SecurityAuditQuery
): SecurityAuditEvent[] {
  const filtered = events.filter((ev) => {
    if (query.since != null && ev.ts < query.since) return false
    if (query.until != null && ev.ts > query.until) return false
    if (query.lane && ev.lane !== query.lane) return false
    if (query.event && ev.event !== query.event) return false
    if (query.toolName && ev.toolName !== query.toolName) return false
    return true
  })
  filtered.sort((a, b) => b.ts - a.ts)
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_AUDIT_QUERY_LIMIT, 1), MAX_AUDIT_QUERY_LIMIT)
  return filtered.slice(0, limit)
}

/**
 * 只读查询安全审计日志：扫描 `SecurityAudit-*.log`（按文件名日期粗筛时间范围），
 * 解析 JSON Lines 后按条件过滤。日志目录不存在/读取失败返回空数组（只读查看不阻断）。
 */
export async function querySecurityAuditLog(
  logDir: string,
  query: SecurityAuditQuery
): Promise<SecurityAuditEvent[]> {
  let files: string[]
  try {
    files = (await fs.readdir(logDir)).filter((f) => /^SecurityAudit-\d{8}\.log$/.test(f))
  } catch {
    return []
  }
  // 按文件名日期粗筛：单日文件只含当日事件（本地时区按日切分）
  const dayMs = 24 * 3600 * 1000
  const inRange = (stamp: string): boolean => {
    const dayStart = new Date(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8))
    ).getTime()
    const dayEnd = dayStart + dayMs - 1
    if (query.since != null && dayEnd < query.since) return false
    if (query.until != null && dayStart > query.until) return false
    return true
  }
  const events: SecurityAuditEvent[] = []
  for (const f of files) {
    const stamp = f.slice('SecurityAudit-'.length, -'.log'.length)
    if (!inRange(stamp)) continue
    try {
      const text = await fs.readFile(path.join(logDir, f), 'utf8')
      events.push(...parseSecurityAuditLines(text))
    } catch {
      /* 单文件失败不影响整体查询 */
    }
  }
  return filterSecurityAuditEvents(events, query)
}
