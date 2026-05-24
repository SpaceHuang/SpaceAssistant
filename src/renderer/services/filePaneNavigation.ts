export type FilePaneSelectRequest = {
  relPath: string
  preferWiki?: boolean
}

type Listener = (req: FilePaneSelectRequest) => void

const listeners = new Set<Listener>()

export function isUnderWikiRoot(relPath: string, wikiRootPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const root = wikiRootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return normalized === root || normalized.startsWith(`${root}/`)
}

export function requestFilePaneSelect(req: FilePaneSelectRequest): void {
  for (const fn of listeners) fn(req)
}

export function subscribeFilePaneSelect(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
