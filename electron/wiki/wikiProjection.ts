export interface WikiProjectionPage { pageId: string; title: string; categoryId: string; summary?: string; path: string; revision: number; parentPageId?: string | null }
export interface WikiSuccessEvent { operationId: string; type: string; title: string; revision: number; committedAt: string; pageId?: string; sourceIds?: string[]; changeSummary?: string }

export function buildWikiIndex(pages: WikiProjectionPage[]): string {
  const rows = [...pages].sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.title.localeCompare(b.title) || a.pageId.localeCompare(b.pageId))
  const groups = new Map<string, WikiProjectionPage[]>()
  for (const page of rows) groups.set(page.categoryId, [...(groups.get(page.categoryId) ?? []), page])
  const output = ['# Wiki Index', '']
  for (const [categoryId, entries] of groups) {
    output.push(`## ${categoryId}`, '')
    for (const page of entries) output.push(`- [${page.title}](${page.path})${page.summary ? ` — ${page.summary}` : ''} (revision ${page.revision})`)
    output.push('')
  }
  return `${output.join('\n').trimEnd()}\n`
}

export function buildWikiLog(events: WikiSuccessEvent[]): string {
  const output = ['# Wiki Operation Log', '']
  for (const event of [...events].sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.operationId.localeCompare(b.operationId))) {
    const metadata = [event.pageId ? `page ${event.pageId}` : '', event.sourceIds?.length ? `sources ${event.sourceIds.join(', ')}` : '', event.changeSummary ? `summary ${event.changeSummary.replace(/\s+/g, ' ').trim()}` : ''].filter(Boolean)
    output.push(`- ${event.committedAt} ${event.type} ${event.title} (revision ${event.revision}; ${event.operationId}${metadata.length ? `; ${metadata.join('; ')}` : ''})`)
  }
  return `${output.join('\n').trimEnd()}\n`
}
