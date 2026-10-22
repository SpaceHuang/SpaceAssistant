// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { SearchResult } from '../../src/shared/domainTypes'
import { appendSearchHistory, listSearchHistory } from '../database/operations'
import { searchFilesUnder } from './ipcShared'

export function registerSearchIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {


  ipcMain.handle('search:execute', async (_e, query: string): Promise<SearchResult[]> => {
    const q = query.trim()
    if (!q) return []
    appendSearchHistory(ctx.db, q)
    const results: SearchResult[] = []
    const activeProfileId = ctx.workDirManager.getActiveProfileId()
    const storage = ctx.sessionStorage!
    let hits = storage.queries.searchMessages({ query: q, activeProfileId, limit: 50 })
    if (storage.ensureChatBodyV1) {
      const sessionIds = [...new Set(hits.filter((hit) => hit.requiresProjectionPreparation).map(({ sessionId }) => sessionId))]
      if (sessionIds.length) {
        for (const sessionId of sessionIds) await storage.ensureChatBodyV1({ sessionId })
        // Cross-session preparation may change a source between reads; rerun the full query
        // so final candidates, body authority, ordering, and limit share a fresh SQLite snapshot.
        hits = storage.queries.searchMessages({ query: q, activeProfileId, limit: 50 })
      }
    }
    for (const hit of hits) {
      results.push({
        id: `msg:${hit.messageId}`,
        type: 'session',
        title: hit.sessionName ?? hit.sessionId,
        preview: hit.content.slice(0, 160),
        sessionId: hit.sessionId,
        messageId: hit.messageId
      })
    }
    const root = ctx.getWorkDir()
    await searchFilesUnder(root, root, q, results, 0, 40)
    return results
  })

  ipcMain.handle('search:get-history', (): string[] => listSearchHistory(ctx.db))
}
