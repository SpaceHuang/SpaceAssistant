// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import fs from 'fs/promises'
import path from 'path'
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { BrowserWindow, dialog, shell } from 'electron'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { FileInfo } from '../../src/shared/domainTypes'
import { buildLocalFileViewerUrl } from '../fileViewerUrl'
import { copyFileInWorkDir } from '../wiki/wikiImport'
import { defaultPdfSavePath, getFileMetadata, readFileForViewer } from '../fileReadHelpers'
import { getMainWindow } from '../windowRef'
import { normalizeRelPathInput, resolveSafePath } from '../pathSecurity'
import { withTransientLockRetry } from '../safeAtomicWrite'

export function registerFileIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
  ipcMain.handle('file:list-directory', async (_e, rel: string): Promise<FileInfo[]> => {
    const root = ctx.getWorkDir()
    const normalized = normalizeRelPathInput(typeof rel === 'string' ? rel : '')
    const target = normalized === '' || normalized === '.' ? root : resolveSafePath(root, normalized)
    const entries = await fs.readdir(target, { withFileTypes: true })
    const out: FileInfo[] = []
    for (const ent of entries) {
      const p = path.join(target, ent.name)
      let size: number | undefined
      if (ent.isFile()) {
        try {
          const st = await fs.stat(p)
          size = st.size
        } catch {
          size = undefined
        }
      }
      out.push({
        name: ent.name,
        path: normalizeRelPathInput(path.relative(root, p) || '.'),
        isDirectory: ent.isDirectory(),
        size
      })
    }
    return out.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  })

  ipcMain.handle('file:read-file', async (_e, rel: string) => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, normalizeRelPathInput(typeof rel === 'string' ? rel : ''))
    return readFileForViewer(target)
  })

  ipcMain.handle('file:get-metadata', async (_e, rel: string) => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, normalizeRelPathInput(typeof rel === 'string' ? rel : ''))
    return getFileMetadata(target)
  })

  ipcMain.handle('file:watch-content', async (event, payload: { relPath: string | null }) => {
    const { startContentWatch, stopContentWatch } = await import('../fileContentWatcher')
    if (payload.relPath === null) {
      stopContentWatch()
      return
    }
    if (typeof payload.relPath !== 'string' || !payload.relPath.trim()) {
      stopContentWatch()
      return
    }
    startContentWatch(ctx.getWorkDir(), payload.relPath.trim())
  })

  ipcMain.handle('file:to-viewer-url', async (_e, rel: unknown) => {
    try {
      if (typeof rel !== 'string' || !rel.trim()) {
        return { ok: false as const, error: 'invalid path' }
      }
      const root = ctx.getWorkDir()
      const target = resolveSafePath(root, rel)
      const st = await fs.stat(target)
      if (!st.isFile()) {
        return { ok: false as const, error: 'not a file' }
      }
      return { ok: true as const, url: buildLocalFileViewerUrl(target) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:open-in-system', async (_e, rel: string) => {
    try {
      const root = ctx.getWorkDir()
      const target = resolveSafePath(root, rel)
      const err = await shell.openPath(target)
      if (err) return { ok: false as const, error: err }
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:show-in-explorer', async (_e, rel: string) => {
    try {
      const root = ctx.getWorkDir()
      const target = resolveSafePath(root, rel)
      shell.showItemInFolder(target)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    'file:export-pdf',
    async (
      _e,
      payload: { htmlContent: string; defaultPath: string }
    ): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> => {
      const win = getMainWindow()
      if (!win) return { ok: false, error: ErrorCodes.WINDOW_NOT_READY }

      const root = ctx.getWorkDir()
      const absFile = path.isAbsolute(payload.defaultPath)
        ? payload.defaultPath
        : resolveSafePath(root, payload.defaultPath)
      const absDefault = defaultPdfSavePath(absFile)

      const saveResult = await dialog.showSaveDialog(win, {
        defaultPath: absDefault,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (saveResult.canceled || !saveResult.filePath) {
        return { ok: false, canceled: true }
      }

      const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
      try {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; line-height: 1.6; }
          pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
          code { font-family: 'SFMono-Regular', 'Cascadia Code', Menlo, monospace; font-size: 13px; }
          img { max-width: 100%; }
        </style></head><body>${payload.htmlContent}</body></html>`
        const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
        await pdfWin.loadURL(dataUrl)
        const pdfBuffer = await pdfWin.webContents.printToPDF({ printBackground: true })
        await fs.writeFile(saveResult.filePath, pdfBuffer)
        return { ok: true, path: saveResult.filePath }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      } finally {
        pdfWin.destroy()
      }
    }
  )

  ipcMain.handle('file:create-file', async (_e, rel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, '')
  })

  ipcMain.handle('file:create-directory', async (_e, rel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, rel)
    await fs.mkdir(target, { recursive: true })
  })

  ipcMain.handle('file:delete', async (_e, rel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, rel)
    await fs.rm(target, { recursive: true, force: true })
  })

  ipcMain.handle('file:rename', async (_e, rel: string, newName: string): Promise<void> => {
    if (newName.includes('/') || newName.includes('\\')) {
      throw new Error(ErrorCodes.NAME_CONTAINS_PATH_SEPARATOR)
    }
    const root = ctx.getWorkDir()
    const oldPath = resolveSafePath(root, rel)
    const newPath = path.join(path.dirname(oldPath), newName)
    await withTransientLockRetry(() => fs.rename(oldPath, newPath))
  })

  ipcMain.handle('file:move', async (_e, srcRel: string, destDirRel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const srcPath = resolveSafePath(root, srcRel)
    const destDirPath = resolveSafePath(root, destDirRel)
    const destStat = await fs.stat(destDirPath)
    if (!destStat.isDirectory()) {
      throw new Error(ErrorCodes.TARGET_NOT_DIRECTORY)
    }
    const srcName = path.basename(srcPath)
    await withTransientLockRetry(() => fs.rename(srcPath, path.join(destDirPath, srcName)))
  })

  ipcMain.handle('file:copy', async (_e, payload: { srcRelPath: string; destRelPath: string }): Promise<void> => {
    await copyFileInWorkDir(ctx.getWorkDir(), payload.srcRelPath, payload.destRelPath)
  })
}
