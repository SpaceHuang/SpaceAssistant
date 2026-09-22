// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import fs from 'fs/promises'
import os from 'node:os'
import path from 'path'
import { createRequire } from 'node:module'
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
import { atomicWrite, buildMarkdownDocx, markdownToPrintHtml, isSupportedMarkdownExport, markdownResourceUrls, sameFileIdentity, MAX_MARKDOWN_EXPORT_IMAGES, MAX_MARKDOWN_EXPORT_IMAGE_BYTES, MAX_MARKDOWN_EXPORT_TOTAL_IMAGE_BYTES } from '../markdownExport'
import { defaultMarkdownExportPath, normalizeMarkdownExportPath, isMarkdownExportablePath, type MarkdownExportResult } from '../../src/shared/markdownExport'
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

  ipcMain.handle('file:export-markdown', async (_e, payload: { format: unknown; markdown: unknown; sourcePath: unknown }): Promise<MarkdownExportResult> => {
    if (!isSupportedMarkdownExport(payload?.format) || typeof payload.markdown !== 'string' || typeof payload.sourcePath !== 'string') return { ok: false, error: '导出参数无效' }
    const root = ctx.getWorkDir()
    let source: string
    try { source = resolveSafePath(root, payload.sourcePath) } catch { return { ok: false, error: '导出参数无效' } }
    if (!isMarkdownExportablePath(source)) return { ok: false, error: '仅支持导出 Markdown 文件' }
    const win = getMainWindow(); if (!win) return { ok: false, error: ErrorCodes.WINDOW_NOT_READY }
    const saved = await dialog.showSaveDialog(win, { defaultPath: defaultMarkdownExportPath(source, payload.format), filters: [{ name: payload.format === 'docx' ? 'Word 文档' : 'PDF', extensions: [payload.format] }] })
    if (saved.canceled || !saved.filePath) return { ok: false, canceled: true }
    const target = normalizeMarkdownExportPath(saved.filePath, payload.format)
    const warnings: string[] = []
    const images = new Map<string, { data: Buffer; type: 'png' | 'jpg' | 'gif' | 'bmp' }>(); const printImages = new Map<string, { data: Buffer; mime: string }>(); let total = 0
    let imageCount = 0
    for (const resource of markdownResourceUrls(payload.markdown)) {
      if (++imageCount > MAX_MARKDOWN_EXPORT_IMAGES) { warnings.push(`图片数量超过上限，未嵌入：${resource}`); continue }
      try {
        const decoded = decodeURIComponent(resource); if (/^[a-z]+:/i.test(decoded)) { warnings.push(`未嵌入资源：${resource}`); continue }
        const file = await resolveSafeReadPath(root, path.resolve(path.dirname(source), decoded)); const ext = path.extname(file).toLowerCase()
        if (!['.png', '.jpg', '.jpeg', '.gif', '.bmp'].includes(ext)) { warnings.push(`未嵌入不支持的图片：${resource}`); continue }
        const stat = await fs.stat(file); if (stat.size > MAX_MARKDOWN_EXPORT_IMAGE_BYTES || total + stat.size > MAX_MARKDOWN_EXPORT_TOTAL_IMAGE_BYTES) { warnings.push(`图片资源超过大小上限，未嵌入：${resource}`); continue }
        const data = await fs.readFile(file); total += data.length; const type = (ext === '.jpeg' ? 'jpg' : ext.slice(1)) as 'png' | 'jpg' | 'gif' | 'bmp'
        for (const key of new Set([resource, decoded, encodeURI(decoded)])) { images.set(key, { data, type }); printImages.set(key, { data, mime: type === 'jpg' ? 'image/jpeg' : `image/${type}` }) }
      } catch { warnings.push(`未嵌入不安全资源：${resource}`) }
    }
    try {
      const sourceStat = await fs.stat(source)
      try { const targetStat = await fs.stat(target); if (sameFileIdentity(sourceStat, targetStat)) return { ok: false, error: '不能覆盖源 Markdown 文件' } } catch { /* 目标不存在时无需身份比对 */ }
      try {
        await fs.stat(target)
        const confirm = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '覆盖'], defaultId: 0, cancelId: 0, title: '确认覆盖', message: `目标文件已存在：${path.basename(target)}` })
        if (confirm.response !== 1) return { ok: false, canceled: true }
      } catch { /* 目标不存在时直接写入 */ }
      if (payload.format === 'docx') { await atomicWrite(target, await buildMarkdownDocx(payload.markdown, images)); return { ok: true, path: target, ...(warnings.length ? { warnings } : {}) } }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    const pdfWindow = new BrowserWindow({ show: false, webPreferences: { offscreen: true } }); let printDir: string | undefined
    try {
      let katexCss = ''
      try {
        const nodeRequire = createRequire(__filename)
        const katexCssPath = nodeRequire.resolve('katex/dist/katex.min.css')
        katexCss = await replaceCssAssetsWithData(await fs.readFile(katexCssPath, 'utf8'), path.dirname(katexCssPath))
      } catch { /* katex 样式缺失时回退为无 CSS 渲染，不阻断导出 */ }
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
          ${katexCss}
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; line-height: 1.6; }
          h1,h2,h3,h4,h5,h6 { line-height: 1.25; margin: 1.2em 0 .6em; }
          table { border-collapse: collapse; width: 100%; table-layout: fixed; margin: 1em 0; }
          th, td { border: 1px solid #cbd5e1; padding: 6px 8px; vertical-align: top; overflow-wrap: anywhere; }
          th { background: #f1f5f9; font-weight: 600; }
          blockquote { border-left: 3px solid #94a3b8; margin: 1em 0; padding-left: 1em; color: #475569; }
          pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
          code { font-family: 'SFMono-Regular', 'Cascadia Code', Menlo, monospace; font-size: 13px; }
          img { max-width: 100%; }
        </style></head><body>${await markdownToPrintHtml(payload.markdown, printImages)}</body></html>`
      printDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spaceassistant-markdown-pdf-'))
      const htmlPath = path.join(printDir, 'index.html'); await fs.writeFile(htmlPath, html, { flag: 'wx' }); await pdfWindow.loadFile(htmlPath)
      await atomicWrite(target, await pdfWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 } }))
      return { ok: true, path: target, ...(warnings.length ? { warnings } : {}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } finally { if (printDir) await fs.rm(printDir, { recursive: true, force: true }).catch(() => undefined); pdfWindow.destroy() }
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

/** 将 CSS 中的本地字体/资源引用内联为 data URL（PDF 离屏渲染无文件系统访问）。 */
async function replaceCssAssetsWithData(css: string, cssDir: string): Promise<string> {
  const assetPattern = /url\((['"]?)([^)'\"]+)\1\)/g
  let result = css

  for (const match of css.matchAll(assetPattern)) {
    const assetPath = match[2]
    if (/^(?:data:|https?:)/i.test(assetPath)) continue

    try {
      const asset = await fs.readFile(path.resolve(cssDir, assetPath))
      const extension = path.extname(assetPath).toLowerCase()
      const mimeType = extension === '.woff2'
        ? 'font/woff2'
        : extension === '.woff'
          ? 'font/woff'
          : extension === '.ttf'
            ? 'font/ttf'
            : 'application/octet-stream'
      result = result.replace(match[0], `url(data:${mimeType};base64,${asset.toString('base64')})`)
    } catch {
      // 缺失的可选字体不应阻断导出；浏览器会回退到系统字体。
    }
  }

  return result
}
