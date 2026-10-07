import type { IpcMain } from 'electron'
import {
  registerClaudeStreamHandlers as registerClaudeStreamHandlersWithPorts,
  type ClaudeStreamDeps
} from '../claudeStreamHandlers'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

/** Test composition helper: bind SQLite ports for legacy fixtures that only supplied the DB getter. */
export function registerClaudeStreamHandlers(ipcMain: IpcMain, deps: ClaudeStreamDeps) {
  return registerClaudeStreamHandlersWithPorts(ipcMain, {
    ...deps,
    sessionStorage: deps.sessionStorage ?? createSqliteSessionStorage(deps.getAppDatabase())
  })
}
