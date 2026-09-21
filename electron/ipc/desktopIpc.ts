// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import fs from 'fs/promises'
import path from 'path'
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { app, dialog, shell } from 'electron'
import { completeRendererSessionSwitch } from '../remote/requestRendererSessionSwitch'
import { getMainWindow } from '../windowRef'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { openExternalLink } from '../externalLink'
import { stagehandService } from '../browser/stagehandService'
import { scriptParserService } from '../shell/scriptParserService'

export function registerDesktopIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
  ipcMain.handle('app:get-tray-enabled', () => ctx.isTrayEnabled?.() ?? false)

  ipcMain.handle('app:open-external', async (_e, url: unknown) => {
    if (typeof url !== 'string') {
      return { ok: false as const, error: 'invalid url' }
    }
    try {
      await openExternalLink(url)
      return { ok: true as const }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, error: message }
    }
  })

  // 桌面端“信任/记住”勾选统一经 AuditedDecisionCache 落 cache.write 审计（§5.6-4）。

  ipcMain.handle('mcp:open-result-artifact', async (_e, payload: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { resolveMcpArtifactPath, resolveMcpArtifactOwnerPath } = await import('../mcp/mcpArtifactPath')
    const artifactId = payload && typeof payload === 'object' ? (payload as { artifactId?: unknown }).artifactId : undefined
    const owner = payload && typeof payload === 'object' ? (payload as { owner?: unknown }).owner : undefined
    const target = resolveMcpArtifactPath(ctx.getUserDataPath(), artifactId)
    if (!target) return { ok: false, error: ErrorCodes.INVALID_PATH }
    const ownerPath = resolveMcpArtifactOwnerPath(ctx.getUserDataPath(), artifactId)
    if (!ownerPath) return { ok: false, error: ErrorCodes.INVALID_PATH }
    try {
      const storedOwner = JSON.parse(await fs.readFile(ownerPath, 'utf8'))
      const { isMcpArtifactOwner } = await import('../../src/shared/mcpArtifactSecurity')
      if (!isMcpArtifactOwner(owner as never, storedOwner)) return { ok: false, error: ErrorCodes.INVALID_PATH }
    } catch {
      return { ok: false, error: ErrorCodes.INVALID_PATH }
    }
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ipcMain.handle('browser:detect', async (_e, force?: boolean) => {
    stagehandService.configureDetectContext(ctx.getBrowserDetectContext())
    return stagehandService.detectDependencies(force === true)
  })

  ipcMain.handle('browser:open-terminal', async () => {
    stagehandService.configureDetectContext(ctx.getBrowserDetectContext())
    const detect = await stagehandService.detectDependencies(true)
    const { openTerminalAtCwd } = await import('../browser/openTerminalAtCwd')
    return openTerminalAtCwd(detect.recommendedCwd, ctx.getBrowserDetectContext())
  })

  ipcMain.handle('dialog:select-directory', async (): Promise<{ path: string } | { canceled: true } | { error: string }> => {
    const win = getMainWindow()
    if (!win) return { error: ErrorCodes.WINDOW_NOT_READY }
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('workdir:list', () => ctx.workDirManager.listProfiles())

  ipcMain.handle(
    'workdir:add',
    (_e, profile: { name: string; path: string; aliases?: string[]; isDefault?: boolean }) =>
      ctx.workDirManager.addProfile(profile)
  )

  ipcMain.handle(
    'workdir:update',
    (_e, payload: { profileId: string; updates: Partial<import('../../src/shared/feishuTypes').WorkDirProfile> }) =>
      ctx.workDirManager.updateProfile(payload.profileId, payload.updates)
  )

  ipcMain.handle('workdir:remove', (_e, payload: { profileId: string }) =>
    ctx.workDirManager.removeProfile(payload.profileId)
  )

  ipcMain.handle('workdir:switch', async (_e, payload: { profileId: string }) => {
    const fromId = ctx.workDirManager.getActiveProfileId()
    const profiles = ctx.workDirManager.listProfiles()
    const from = profiles.find((p) => p.id === fromId)
    const to = profiles.find((p) => p.id === payload.profileId)
    logAgentEvent('info', 'workdir.switch.start', {
      fromProfileId: fromId,
      fromProfileName: from?.name ?? fromId,
      toProfileId: payload.profileId,
      toProfileName: to?.name ?? payload.profileId
    })
    const result = await ctx.workDirManager.switchProfile(payload.profileId)
    if (!result.success) {
      logAgentEvent('error', 'workdir.switch.error', { error: result.error, profileId: payload.profileId })
    }
    return result
  })

  ipcMain.handle('workdir:check-writable', (_e, payload: { path: string }) =>
    ctx.workDirManager.checkDirectoryWritable(payload.path)
  )

  ipcMain.handle(
    'remote:switch-session-complete',
    async (_e, payload: { requestId: string; desktopSwitched: boolean; viewChanged: boolean }) => {
      completeRendererSessionSwitch(payload)
    }
  )

  // 浮动通知 IPC

  ipcMain.handle('notification:ready', async () => {
    ctx.floatingNotificationManager?.onNotificationReady()
  })

  ipcMain.handle('notification:get-data', async () => {
    if (ctx.floatingNotificationManager) {
      return ctx.floatingNotificationManager.getCurrentData()
    }
    return { totalSessions: 0, totalItems: 0, latestItem: null }
  })

  ipcMain.handle('notification:focus-session', async (_e, payload: { sessionId: string; toolUseId?: string }) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      win.focus()
      win.webContents.send('notification:navigate-session', payload)
    }
    ctx.floatingNotificationManager?.onReturnToMain()
  })

  ipcMain.handle('notification:show-main', async () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    ctx.floatingNotificationManager?.onReturnToMain()
  })

  ipcMain.handle('notification:dismiss', async () => {
    ctx.floatingNotificationManager?.dismiss()
  })

  ipcMain.handle('test-pop:show', async () => {
    if (!ctx.floatingNotificationManager) return
    ctx.floatingNotificationManager.showTestNotification()
  })

  // P0-T4：脚本安全解析状态（诊断展示：解析不可用时 UI 显示「全部降级为人工确认」）
  ipcMain.handle('treesitter:get-status', () => scriptParserService.getStatus())
}
