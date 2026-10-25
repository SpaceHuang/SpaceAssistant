// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { SearchResult } from '../../src/shared/domainTypes'
import { createSearchHistoryStore } from '../database/searchHistory'
import { searchFilesUnder } from './ipcShared'
import { prepareChatBodyForRead } from '../sessionStorage/public/readPreparation'
import type { MessageSearchHit } from '../sessionStorage/public/model'

export function registerSearchIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
  const searchHistory = createSearchHistoryStore(ctx.db)

  ipcMain.handle('search:execute', async (_e, query: string): Promise<SearchResult[]> => {
    const q = query.trim()
    if (!q) return []
    searchHistory.append(q)
    const results: SearchResult[] = []
    const activeProfileId = ctx.workDirManager.getActiveProfileId()
    const storage = ctx.sessionStorage!
    let hits: MessageSearchHit[] = []
    if (storage.ensureChatBodyV1 && storage.queries.searchPreparedMessages) {
      let usedPreparedSearch = false
      for (let attempt = 0; attempt < 2 && !usedPreparedSearch; attempt++) {
        try {
          hits = await storage.queries.searchPreparedMessages({ query: q, activeProfileId, limit: 50,
            prepareSession: async (sessionId) => {
              const prepared = await prepareChatBodyForRead(storage.ensureChatBodyV1!, sessionId)
              return prepared as import('../sessionStorage/public/model').PreparedChatBodyView | undefined
            } })
          usedPreparedSearch = true
        } catch (error) {
          if (error instanceof Error && error.message === 'GLOBAL_SEARCH_SOURCE_CHANGED' && attempt === 0) continue
          if (error instanceof Error && error.message === 'PREPARED_SEARCH_UNAVAILABLE') {
            hits = storage.queries.searchMessages({ query: q, activeProfileId, limit: 50 })
            usedPreparedSearch = true
            break
          }
          throw error
        }
      }
      if (!usedPreparedSearch) hits = storage.queries.searchMessages({ query: q, activeProfileId, limit: 50 })
    } else {
      hits = storage.queries.searchMessages({ query: q, activeProfileId, limit: 50 })
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

  ipcMain.handle('search:get-history', (): string[] => searchHistory.list())
}
