// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { SearchResult } from '../../src/shared/domainTypes'
import { appendSearchHistory, listSearchHistory, searchMessages } from '../database'
import { searchFilesUnder } from './ipcShared'

export function registerSearchIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {


  ipcMain.handle('search:execute', async (_e, query: string): Promise<SearchResult[]> => {
    const q = query.trim()
    if (!q) return []
    appendSearchHistory(ctx.db, q)
    const results: SearchResult[] = []
    const activeProfileId = ctx.workDirManager.getActiveProfileId()
    for (const hit of searchMessages(ctx.db, q, activeProfileId, 50)) {
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
