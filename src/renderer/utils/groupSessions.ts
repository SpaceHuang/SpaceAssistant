import type { Session } from '../../shared/domainTypes'

export type SessionGroup = {
  label: string
  sessions: Session[]
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function sessionTime(s: Session): number {
  return s.updatedAt ?? s.createdAt ?? 0
}

export function groupSessionsByTime(sessions: Session[]): SessionGroup[] {
  const now = new Date()
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - 6 * 86400000

  const buckets: Record<string, Session[]> = {
    今天: [],
    昨天: [],
    最近7天: [],
    更早: []
  }

  const sorted = [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a))

  for (const s of sorted) {
    const t = sessionTime(s)
    if (t >= todayStart) buckets['今天'].push(s)
    else if (t >= yesterdayStart) buckets['昨天'].push(s)
    else if (t >= weekStart) buckets['最近7天'].push(s)
    else buckets['更早'].push(s)
  }

  return (['今天', '昨天', '最近7天', '更早'] as const)
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, sessions: buckets[label] }))
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return new Date(ts).toLocaleDateString()
}
