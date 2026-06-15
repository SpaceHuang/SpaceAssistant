import { FSWatcher, watch } from 'fs'
import type { WebContents } from 'electron'
import { resolveSafePath } from './pathSecurity'
import { safeWebContentsSend } from './safeWebContentsSend'
import { logAgentEvent } from './agentLogger/agentLogger'
import type { FileContentChangedEvent } from '../src/shared/fileContentSync'

let watcher: FSWatcher | null = null
let watchedRelPath: string | null = null

export function startContentWatch(
  workDir: string,
  relPath: string,
  sender: WebContents
): void {
  stopContentWatch()

  try {
    const absPath = resolveSafePath(workDir, relPath)
    watchedRelPath = relPath

    watcher = watch(absPath, (eventType) => {
      if (eventType !== 'change') return
      const payload: FileContentChangedEvent = { relPath }
      safeWebContentsSend(sender, 'file:content-changed', payload)
    })

    watcher.on('error', (err) => {
      logAgentEvent('warn', 'fileContentWatcher.error', {
        relPath,
        error: err.message
      })
    })
  } catch (err) {
    logAgentEvent('warn', 'fileContentWatcher.startFailed', {
      relPath,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

export function stopContentWatch(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  watchedRelPath = null
}

export function stopAllContentWatches(): void {
  stopContentWatch()
}

/** @internal test helper */
export function getWatchedRelPathForTests(): string | null {
  return watchedRelPath
}
