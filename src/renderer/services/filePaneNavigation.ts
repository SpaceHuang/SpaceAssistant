export type FilePaneSelectRequest = {
  relPath: string
  preferWiki?: boolean
}

type Listener = (req: FilePaneSelectRequest) => void

const listeners = new Set<Listener>()
let pendingSelect: FilePaneSelectRequest | null = null

export function isUnderWikiRoot(relPath: string, wikiRootPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const root = wikiRootPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  return normalized === root || normalized.startsWith(`${root}/`)
}

export function requestFilePaneSelect(req: FilePaneSelectRequest): void {
  if (listeners.size === 0) {
    pendingSelect = req
    return
  }
  for (const fn of listeners) fn(req)
}

export function subscribeFilePaneSelect(listener: Listener): () => void {
  listeners.add(listener)
  if (pendingSelect) {
    listener(pendingSelect)
    pendingSelect = null
  }
  return () => listeners.delete(listener)
}

/** @internal test helper */
export function resetFilePaneNavigationForTests(): void {
  listeners.clear()
  pendingSelect = null
}
