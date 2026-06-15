export type FileContentChangedEvent = { relPath: string }

export type FileContentSyncReason = 'paths' | 'watch' | 'refreshExpanded'

export const FILE_CONTENT_DEBOUNCE_MS = 500
export const FILE_CONTENT_SETTLE_MS = 300
export const FILE_CONTENT_MAX_WAIT_MS = 5000
