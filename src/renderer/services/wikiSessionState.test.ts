import { describe, expect, it } from 'vitest'
import { appendArchivedQuery, getSessionWikiState, SESSION_META_WIKI } from './wikiSessionState'

describe('wikiSessionState', () => {
  it('appends archived query paths without duplicates', () => {
    const first = appendArchivedQuery({}, 'llm-wiki/wiki/queries/2026-05-24-archive.md')
    expect(getSessionWikiState(first).archivedQueries).toEqual(['llm-wiki/wiki/queries/2026-05-24-archive.md'])

    const second = appendArchivedQuery(first, 'llm-wiki/wiki/queries/2026-05-24-archive.md')
    expect(getSessionWikiState(second).archivedQueries).toHaveLength(1)

    const third = appendArchivedQuery(second, 'llm-wiki/wiki/queries/other.md')
    expect(getSessionWikiState(third).archivedQueries).toEqual([
      'llm-wiki/wiki/queries/2026-05-24-archive.md',
      'llm-wiki/wiki/queries/other.md'
    ])
    expect(third[SESSION_META_WIKI]).toBeDefined()
  })
})
