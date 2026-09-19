import { FSWatcher, watch } from 'fs'
import { resolveSafePath } from './pathSecurity'
import { logAgentEvent } from './agentLogger/agentLogger'
import { nextFileScopeVersion } from './fileScopeVersion'
import { broadcastScopeInvalidation } from './ipc/invalidationOutlet'

let watcher: FSWatcher | null = null
let watchedRelPath: string | null = null

export function startContentWatch(
  workDir: string,
  relPath: string
): void {
  stopContentWatch()

  try {
    const absPath = resolveSafePath(workDir, relPath)
    watchedRelPath = relPath

    watcher = watch(absPath, (eventType) => {
      if (eventType !== 'change') return
      // 偏差 11/3c:文件内容失效广播 { scope: 'file:<path>', version },渲染端收到后自行 file:read-file 重取
      broadcastScopeInvalidation(`file:${relPath}`, nextFileScopeVersion())
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
