import {
  FILE_CONTENT_DEBOUNCE_MS,
  FILE_CONTENT_MAX_WAIT_MS,
  FILE_CONTENT_SETTLE_MS,
  type FileContentSyncReason
} from '../../shared/fileContentSync'
import { normalizeRelPath } from '../../shared/fileTreeSync'

export type FileContentSyncReadyEvent =
  | { kind: 'path'; relPath: string; reason: Exclude<FileContentSyncReason, 'refreshExpanded'> }
  | { kind: 'refreshExpanded' }

type ReadyListener = (event: FileContentSyncReadyEvent) => void
type MetadataGetter = (relPath: string) => Promise<{ mtime: number; size: number } | null>

const readyListeners = new Set<ReadyListener>()
let pendingPaths = new Map<string, Exclude<FileContentSyncReason, 'refreshExpanded'>>()
let pendingRefreshExpanded = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let settleAbort: AbortController | null = null
let ipcSubscribed = false
let metadataGetter: MetadataGetter | null = null

function clearDebounceTimer(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

function abortSettle(): void {
  if (settleAbort) {
    settleAbort.abort()
    settleAbort = null
  }
}

function scheduleDebounce(): void {
  clearDebounceTimer()
  debounceTimer = setTimeout(() => {
    void flushPending()
  }, FILE_CONTENT_DEBOUNCE_MS)
}

async function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true }
    )
  })
}

async function defaultGetMetadata(relPath: string): Promise<{ mtime: number; size: number } | null> {
  try {
    const meta = await window.api.fileGetMetadata(relPath)
    return { mtime: meta.mtime, size: meta.size }
  } catch {
    return null
  }
}

async function settlePath(
  relPath: string,
  reason: Exclude<FileContentSyncReason, 'refreshExpanded'>,
  getMetadata: MetadataGetter,
  signal: AbortSignal
): Promise<void> {
  const startedAt = Date.now()
  let meta = await getMetadata(relPath)
  if (!meta || signal.aborted) return

  while (!signal.aborted) {
    try {
      await waitMs(FILE_CONTENT_SETTLE_MS, signal)
    } catch {
      return
    }
    if (signal.aborted) return

    const meta2 = await getMetadata(relPath)
    if (!meta2) return
    if (meta2.mtime === meta.mtime) break
    meta = meta2
    if (Date.now() - startedAt >= FILE_CONTENT_MAX_WAIT_MS) break
  }

  if (signal.aborted) return
  for (const fn of readyListeners) fn({ kind: 'path', relPath, reason })
}

async function flushPending(): Promise<void> {
  debounceTimer = null
  abortSettle()

  const paths = new Map(pendingPaths)
  const refreshExpanded = pendingRefreshExpanded
  pendingPaths = new Map()
  pendingRefreshExpanded = false

  if (paths.size === 0 && !refreshExpanded) return

  if (refreshExpanded) {
    for (const fn of readyListeners) fn({ kind: 'refreshExpanded' })
  }

  if (paths.size === 0) return

  const controller = new AbortController()
  settleAbort = controller
  const getMetadata = metadataGetter ?? defaultGetMetadata

  await Promise.all(
    [...paths.entries()].map(([relPath, reason]) =>
      settlePath(relPath, reason, getMetadata, controller.signal)
    )
  )
  if (settleAbort === controller) settleAbort = null
}

function enqueuePath(relPath: string, reason: Exclude<FileContentSyncReason, 'refreshExpanded'>): void {
  const normalized = normalizeRelPath(relPath)
  if (!normalized) return
  const prev = pendingPaths.get(normalized)
  if (prev === 'watch' && reason === 'paths') {
    pendingPaths.set(normalized, 'paths')
  } else if (!prev || reason === 'paths') {
    pendingPaths.set(normalized, reason)
  }
  scheduleDebounce()
}

function onTreeChanged(event: import('../../shared/fileTreeSync').FileTreeChangeEvent): void {
  if (event.kind === 'refreshExpanded') {
    pendingRefreshExpanded = true
    scheduleDebounce()
    return
  }
  for (const p of event.relPaths) enqueuePath(p, 'paths')
}

function onContentChanged(event: import('../../shared/fileContentSync').FileContentChangedEvent): void {
  enqueuePath(event.relPath, 'watch')
}

export function subscribeFileContentSync(listener: ReadyListener): () => void {
  readyListeners.add(listener)
  return () => readyListeners.delete(listener)
}

export function enqueueContentSync(
  relPath: string,
  reason: Exclude<FileContentSyncReason, 'refreshExpanded'> = 'paths'
): void {
  enqueuePath(relPath, reason)
}

export function cancelFileContentSync(): void {
  clearDebounceTimer()
  abortSettle()
  pendingPaths = new Map()
  pendingRefreshExpanded = false
}

export function ensureFileContentSyncIpc(): void {
  if (ipcSubscribed) return
  ipcSubscribed = true
  window.api.fileOnTreeChanged(onTreeChanged)
  window.api.fileOnContentChanged(onContentChanged)
}

/** @internal test helper */
export function setFileContentMetadataGetterForTests(getter: MetadataGetter | null): void {
  metadataGetter = getter
}

/** @internal test helper */
export function resetFileContentSyncBusForTests(): void {
  readyListeners.clear()
  cancelFileContentSync()
  ipcSubscribed = false
  metadataGetter = null
}

/** @internal test helper */
export function emitFileContentSyncForTests(
  relPath: string,
  reason: Exclude<FileContentSyncReason, 'refreshExpanded'> = 'paths'
): void {
  enqueuePath(relPath, reason)
}

/** @internal test helper — bypass IPC, directly flush debounce + settle */
export async function flushFileContentSyncForTests(): Promise<void> {
  clearDebounceTimer()
  await flushPending()
}

/** @internal test helper */
export function emitRefreshExpandedForTests(): void {
  pendingRefreshExpanded = true
  scheduleDebounce()
}
