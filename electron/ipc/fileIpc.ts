// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import fs from 'fs/promises'
import os from 'node:os'
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
import { atomicWrite, buildMarkdownDocx, markdownToPrintHtml, isSupportedMarkdownExport, markdownResourceUrls, MAX_MARKDOWN_EXPORT_IMAGE_BYTES, MAX_MARKDOWN_EXPORT_TOTAL_IMAGE_BYTES } from '../markdownExport'
import { defaultMarkdownExportPath, normalizeMarkdownExportPath, isMarkdownExportablePath } from '../../src/shared/markdownExport'
import { resolveSafeReadPath } from '../pathSecurity'

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

  ipcMain.handle('file:watch-content', async (_event, payload: { relPath: string | null }) => {
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

  ipcMain.handle('file:export-markdown', async (_e, payload: { format: unknown; markdown: unknown; sourcePath: unknown }) => {
    if (!isSupportedMarkdownExport(payload?.format) || typeof payload.markdown !== 'string' || typeof payload.sourcePath !== 'string') return { ok: false, error: '导出参数无效' }
    const root = ctx.getWorkDir(); const sourcePath = payload.sourcePath as string
    const source = resolveSafePath(root, sourcePath)
    if (!isMarkdownExportablePath(source)) return { ok: false, error: '仅支持导出 Markdown 文件' }
    const win = getMainWindow(); if (!win) return { ok: false, error: ErrorCodes.WINDOW_NOT_READY }
    const saved = await dialog.showSaveDialog(win, { defaultPath: defaultMarkdownExportPath(source, payload.format), filters: [{ name: payload.format === 'docx' ? 'Word 文档' : 'PDF', extensions: [payload.format] }] })
    if (saved.canceled || !saved.filePath) return { ok: false, canceled: true }
    const target = normalizeMarkdownExportPath(saved.filePath, payload.format)
    const images = new Map<string, { data: Buffer; type: 'png' | 'jpg' | 'gif' | 'bmp' }>(); const printImages = new Map<string, { data: Buffer; mime: string }>(); let total = 0
    for (const resource of markdownResourceUrls(payload.markdown)) {
      try {
        const decoded = decodeURIComponent(resource); if (/^[a-z]+:/i.test(decoded)) continue
        const file = await resolveSafeReadPath(root, path.resolve(path.dirname(source), decoded)); const ext = path.extname(file).toLowerCase()
        if (!['.png', '.jpg', '.jpeg', '.gif', '.bmp'].includes(ext)) continue
        const stat = await fs.stat(file); if (stat.size > MAX_MARKDOWN_EXPORT_IMAGE_BYTES || total + stat.size > MAX_MARKDOWN_EXPORT_TOTAL_IMAGE_BYTES) continue
        const data = await fs.readFile(file); total += data.length; const type = (ext === '.jpeg' ? 'jpg' : ext.slice(1)) as 'png' | 'jpg' | 'gif' | 'bmp'
        for (const key of new Set([resource, decoded, encodeURI(decoded)])) { images.set(key, { data, type }); printImages.set(key, { data, mime: type === 'jpg' ? 'image/jpeg' : `image/${type}` }) }
      } catch { /* invalid resources are skipped */ }
    }
    try {
      if (payload.format === 'docx') { await atomicWrite(target, await buildMarkdownDocx(payload.markdown, images)); return { ok: true, path: target } }
      const pdfWindow = new BrowserWindow({ show: false, webPreferences: { offscreen: true } }); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spaceassistant-markdown-pdf-'))
      try { const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;line-height:1.6}img{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${await markdownToPrintHtml(payload.markdown, printImages)}</body></html>`; const htmlPath = path.join(dir, 'index.html'); await fs.writeFile(htmlPath, html, { flag: 'wx' }); await pdfWindow.loadFile(htmlPath); await atomicWrite(target, await pdfWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })) } finally { await fs.rm(dir, { recursive: true, force: true }); pdfWindow.destroy() }
      return { ok: true, path: target }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
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
