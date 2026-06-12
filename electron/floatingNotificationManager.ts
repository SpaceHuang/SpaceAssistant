import type { BrowserWindow } from 'electron'
import type { FloatingNotificationData } from '../src/shared/api'
import {
  createFloatingNotificationWindow,
  destroyFloatingNotificationWindow,
  pushDataToFloatingWindow,
  sendCloseToFloatingWindow
} from './floatingNotification'
import type { AppDatabase } from './database'
import { getSession } from './database'

export type PendingConfirmEntry = {
  sessionId: string
  sessionName: string
  toolUseId: string
  toolName: string
  input: unknown
  requestId: string
  createdAt: number
}

function makeKey(requestId: string, toolUseId: string): string {
  return `${requestId}\0${toolUseId}`
}

function buildSimpleToolLabel(toolName: string, input: unknown): string {
  const obj = input as Record<string, unknown> | undefined
  if (!obj) return toolName

  let detail = ''
  if (
    (toolName === 'read_file' || toolName === 'list_directory' ||
     toolName === 'edit_file' || toolName === 'write_file') &&
    typeof obj.path === 'string' && obj.path
  ) {
    detail = obj.path
  } else if (toolName === 'run_shell' && typeof obj.command === 'string' && obj.command) {
    detail = obj.command
  } else if (toolName === 'grep' && typeof obj.pattern === 'string' && obj.pattern) {
    detail = obj.pattern
  }

  return detail ? `${toolName} — ${detail}` : toolName
}

export class FloatingNotificationManager {
  private pendingItems = new Map<string, PendingConfirmEntry>()
  private floatingWin: BrowserWindow | null = null
  private blurTimer: ReturnType<typeof setTimeout> | null = null
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  private dismissed = false
  private mainWindowGetter: () => BrowserWindow | null
  private mainDirname: string
  private db: AppDatabase

  constructor(
    mainWindowGetter: () => BrowserWindow | null,
    mainDirname: string,
    db: AppDatabase
  ) {
    this.mainWindowGetter = mainWindowGetter
    this.mainDirname = mainDirname
    this.db = db
  }

  onConfirmRequest(entry: PendingConfirmEntry): void {
    const key = makeKey(entry.requestId, entry.toolUseId)
    // Resolve session name from DB if not already set
    if (!entry.sessionName || entry.sessionName === entry.sessionId) {
      const session = getSession(this.db, entry.sessionId)
      if (session) {
        entry.sessionName = session.name || entry.sessionId
      }
    }
    this.pendingItems.set(key, entry)
    this.dismissed = false
    this.evaluate()
  }

  onToolResult(requestId: string, toolUseId: string): void {
    const key = makeKey(requestId, toolUseId)
    this.pendingItems.delete(key)
    this.evaluate()
  }

  onAllCancelledForRequest(requestId: string): void {
    const prefix = `${requestId}\0`
    for (const key of this.pendingItems.keys()) {
      if (key.startsWith(prefix)) this.pendingItems.delete(key)
    }
    this.evaluate()
  }

  onMainWindowFocus(): void {
    this.clearBlurTimer()
    this.closeFloatingWindow()
  }

  onMainWindowBlur(): void {
    this.clearBlurTimer()
    this.blurTimer = setTimeout(() => {
      this.blurTimer = null
      this.evaluate()
    }, 2000)
  }

  onMainWindowHide(): void {
    this.clearBlurTimer()
    this.evaluate()
  }

  onMainWindowShow(): void {
    this.clearBlurTimer()
    this.evaluate()
  }

  onMainWindowMinimize(): void {
    this.clearBlurTimer()
    this.evaluate()
  }

  onMainWindowRestore(): void {
    this.clearBlurTimer()
    this.evaluate()
  }

  showTestNotification(): void {
    this.ensureFloatingWindow()
    const testData: FloatingNotificationData = {
      totalSessions: 2,
      totalItems: 3,
      latestItem: {
        sessionId: 'test-session-1',
        sessionName: '测试会话',
        toolUseId: 'test-tool-1',
        toolName: 'run_shell',
        toolLabel: 'run_shell — npm install react',
        createdAt: Date.now()
      }
    }
    pushDataToFloatingWindow(this.floatingWin, testData)
  }

  getCurrentData(): FloatingNotificationData {
    const items = [...this.pendingItems.values()]
    const sessionIds = new Set(items.map((i) => i.sessionId))
    const sorted = items.sort((a, b) => b.createdAt - a.createdAt)
    const latest = sorted[0] ?? null
    return {
      totalSessions: sessionIds.size,
      totalItems: items.length,
      latestItem: latest
        ? {
            sessionId: latest.sessionId,
            sessionName: latest.sessionName,
            toolUseId: latest.toolUseId,
            toolName: latest.toolName,
            toolLabel: buildSimpleToolLabel(latest.toolName, latest.input),
            createdAt: latest.createdAt
          }
        : null
    }
  }

  dismiss(): void {
    this.dismissed = true
    this.closeFloatingWindow()
  }

  destroy(): void {
    this.clearBlurTimer()
    this.clearCloseTimer()
    destroyFloatingNotificationWindow(this.floatingWin)
    this.floatingWin = null
  }

  // --- private ---

  private evaluate(): void {
    const mainWin = this.mainWindowGetter()
    const hasPending = this.pendingItems.size > 0
    const mainVisible = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized()
    const mainFocused = mainWin && !mainWin.isDestroyed() && mainWin.isFocused()

    if (!hasPending) {
      this.scheduleClose()
      return
    }

    if (mainVisible && mainFocused) {
      this.clearCloseTimer()
      this.closeFloatingWindow()
      return
    }

    if (this.dismissed) {
      return
    }

    // Window is hidden/minimized/unfocused → show notification
    this.clearCloseTimer()
    this.ensureFloatingWindow()
    this.pushCurrentData()
  }

  private ensureFloatingWindow(): void {
    if (this.floatingWin && !this.floatingWin.isDestroyed()) return
    this.floatingWin = createFloatingNotificationWindow(this.mainDirname)
  }

  private closeFloatingWindow(): void {
    this.clearCloseTimer()
    sendCloseToFloatingWindow(this.floatingWin)
  }

  private scheduleClose(): void {
    if (this.closeTimer) return
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      this.closeFloatingWindow()
    }, 500)
  }

  private pushCurrentData(): void {
    if (!this.floatingWin || this.floatingWin.isDestroyed()) return

    const items = [...this.pendingItems.values()]
    const sessionIds = new Set(items.map((i) => i.sessionId))
    const sorted = items.sort((a, b) => b.createdAt - a.createdAt)
    const latest = sorted[0] ?? null

    const data: FloatingNotificationData = {
      totalSessions: sessionIds.size,
      totalItems: items.length,
      latestItem: latest
        ? {
            sessionId: latest.sessionId,
            sessionName: latest.sessionName,
            toolUseId: latest.toolUseId,
            toolName: latest.toolName,
            toolLabel: buildSimpleToolLabel(latest.toolName, latest.input),
            createdAt: latest.createdAt
          }
        : null
    }
    pushDataToFloatingWindow(this.floatingWin, data)
  }

  private clearBlurTimer(): void {
    if (this.blurTimer) {
      clearTimeout(this.blurTimer)
      this.blurTimer = null
    }
  }

  private clearCloseTimer(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
  }
}
