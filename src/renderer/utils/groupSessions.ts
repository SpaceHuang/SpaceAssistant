import type { Session } from '../../shared/domainTypes'
import i18n from '../i18n'

export type SessionGroup = {
  label: string
  sessions: Session[]
}

const GROUP_KEYS = ['today', 'yesterday', 'last7Days', 'older'] as const
type GroupKey = (typeof GROUP_KEYS)[number]

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function sessionTime(s: Session): number {
  return s.updatedAt ?? s.createdAt ?? 0
}

function groupLabel(key: GroupKey): string {
  return i18n.t(`session.groups.${key}`, { ns: 'common' })
}

export function groupSessionsByTime(sessions: Session[]): SessionGroup[] {
  const now = new Date()
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - 6 * 86400000

  const buckets: Record<GroupKey, Session[]> = {
    today: [],
    yesterday: [],
    last7Days: [],
    older: []
  }

  const sorted = [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a))

  for (const s of sorted) {
    const t = sessionTime(s)
    if (t >= todayStart) buckets.today.push(s)
    else if (t >= yesterdayStart) buckets.yesterday.push(s)
    else if (t >= weekStart) buckets.last7Days.push(s)
    else buckets.older.push(s)
  }

  return GROUP_KEYS.filter((key) => buckets[key].length > 0).map((key) => ({
    label: groupLabel(key),
    sessions: buckets[key]
  }))
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return i18n.t('time.justNow', { ns: 'common' })
  if (diff < 3600000) {
    return i18n.t('time.minutesAgo', { ns: 'common', count: Math.floor(diff / 60000) })
  }
  if (diff < 86400000) {
    return i18n.t('time.hoursAgo', { ns: 'common', count: Math.floor(diff / 3600000) })
  }
  return new Date(ts).toLocaleDateString(i18n.language)
}
