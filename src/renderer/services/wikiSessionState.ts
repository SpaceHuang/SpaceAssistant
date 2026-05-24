import {
  DEFAULT_SESSION_WIKI_STATE,
  normalizeSessionWikiState,
  type SessionWikiState
} from '../../shared/domainTypes'

export const SESSION_META_WIKI = 'wiki'

export function getSessionWikiState(metadata?: Record<string, unknown> | null): SessionWikiState {
  if (!metadata || typeof metadata !== 'object') return { ...DEFAULT_SESSION_WIKI_STATE }
  return normalizeSessionWikiState(metadata[SESSION_META_WIKI] as Partial<SessionWikiState> | undefined)
}

export function patchSessionWikiState(
  metadata: Record<string, unknown> | undefined | null,
  patch: Partial<SessionWikiState>
): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {}
  const cur = getSessionWikiState(base)
  base[SESSION_META_WIKI] = normalizeSessionWikiState({ ...cur, ...patch })
  return base
}

export function appendArchivedQuery(
  metadata: Record<string, unknown> | undefined | null,
  relPath: string
): Record<string, unknown> {
  const cur = getSessionWikiState(metadata)
  const archivedQueries = cur.archivedQueries.includes(relPath)
    ? cur.archivedQueries
    : [...cur.archivedQueries, relPath]
  return patchSessionWikiState(metadata, { archivedQueries })
}
