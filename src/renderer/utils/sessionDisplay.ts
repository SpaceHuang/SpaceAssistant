import i18n from '../i18n'
import { sessionDisplayNameRaw } from '../../shared/sessionDisplay'

/** 用户手动会话标题最大 Unicode 字符数 */
export const SESSION_TITLE_MAX_LENGTH = 64

/** 侧栏会话列表展示用名称（空标题兜底） */
export function sessionDisplayName(name: string | undefined | null, sessionId?: string): string {
  const raw = sessionDisplayNameRaw(name, sessionId)
  return raw || i18n.t('session.unnamed', { ns: 'common' })
}

/** 确认框等短文案中的长标题截断 */
export function truncateSessionTitle(name: string, maxLen = 48): string {
  if (name.length <= maxLen) return name
  return `${name.slice(0, maxLen)}…`
}

export function sessionListEmptyDescription(
  totalCount: number,
  hasSearchQuery: boolean
): string {
  if (totalCount === 0) return i18n.t('session.emptyNoSessions', { ns: 'common' })
  if (hasSearchQuery) return i18n.t('session.emptyNoMatch', { ns: 'common' })
  return i18n.t('session.emptyDefault', { ns: 'common' })
}
