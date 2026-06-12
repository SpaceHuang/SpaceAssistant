import type { FileTreeChangeEvent } from '../../shared/fileTreeSync'

type Listener = (event: FileTreeChangeEvent) => void

const listeners = new Set<Listener>()
let pendingPaths = new Set<string>()
let pendingRefreshExpanded = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let ipcSubscribed = false

const DEBOUNCE_MS = 400

function flushPending(): void {
  debounceTimer = null
  if (pendingPaths.size > 0) {
    const event: FileTreeChangeEvent = { kind: 'paths', relPaths: [...pendingPaths] }
    pendingPaths = new Set()
    for (const fn of listeners) fn(event)
  }
  if (pendingRefreshExpanded) {
    pendingRefreshExpanded = false
    for (const fn of listeners) fn({ kind: 'refreshExpanded' })
  }
}

function enqueue(event: FileTreeChangeEvent): void {
  if (event.kind === 'refreshExpanded') {
    pendingRefreshExpanded = true
  } else {
    for (const p of event.relPaths) pendingPaths.add(p)
  }
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(flushPending, DEBOUNCE_MS)
}

export function subscribeFileTreeSync(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function ensureFileTreeSyncIpc(): void {
  if (ipcSubscribed) return
  ipcSubscribed = true
  window.api.fileOnTreeChanged(enqueue)
}

/** @internal test helper */
export function resetFileTreeSyncBusForTests(): void {
  listeners.clear()
  pendingPaths = new Set()
  pendingRefreshExpanded = false
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  ipcSubscribed = false
}

/** @internal test helper */
export function emitFileTreeSyncForTests(event: FileTreeChangeEvent): void {
  enqueue(event)
}
