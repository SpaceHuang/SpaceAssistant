import { FSWatcher, watch } from 'fs'
import { resolveSafePath } from './pathSecurity'
import { logAgentEvent } from './agentLogger/agentLogger'
import { nextFileScopeVersion } from './fileScopeVersion'
import { broadcastScopeInvalidation } from './ipc/invalidationOutlet'

let watcher: FSWatcher | null = null
let watchedRelPath: string | null = null

export function startContentWatch(
  workDir: string,
  relPath: string,
  /** BLK-6（§7.4）：广播 scope / 状态键用的路径（挂载命中时传调用方原始词汇路径）；
   *  缺省 = relPath（workDir 内非挂载路径行为不变） */
  broadcastRel = relPath
): void {
  stopContentWatch()

  try {
    const absPath = resolveSafePath(workDir, relPath)
    watchedRelPath = broadcastRel

    watcher = watch(absPath, (eventType) => {
      if (eventType !== 'change') return
      // 偏差 11/3c:文件内容失效广播 { scope: 'file:<path>', version },渲染端收到后自行 file:read-file 重取
      broadcastScopeInvalidation(`file:${broadcastRel}`, nextFileScopeVersion())
    })

    watcher.on('error', (err) => {
      logAgentEvent('warn', 'fileContentWatcher.error', {
        relPath: broadcastRel,
        error: err.message
      })
    })
  } catch (err) {
    logAgentEvent('warn', 'fileContentWatcher.startFailed', {
      relPath: broadcastRel,
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
