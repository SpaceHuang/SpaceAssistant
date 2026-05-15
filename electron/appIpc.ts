import fs from 'fs/promises'
import type { Dirent } from 'fs'
import path from 'path'
import type { IpcMain } from 'electron'
import { BrowserWindow, dialog, shell } from 'electron'
import type { AppDatabase } from './database'
import type { AppConfig, FileInfo, Message, ModelEntry, SearchResult, Session, ToolsConfig } from '../src/shared/domainTypes'
import { DEFAULT_MODELS, mergeToolsConfig } from '../src/shared/domainTypes'
import { createAnthropicClient } from './anthropicClientFactory'
import { assertValidOptionalAnthropicBaseUrl } from './claudeRequestGuards'
import {
  appendMessage,
  appendSearchHistory,
  createSession,
  deleteSession,
  getConfigValue,
  getMessages,
  getSession,
  listSearchHistory,
  listSessions,
  setConfigValue,
  updateMessageContent,
  updateSession
} from './database'
import { resolveSafePath } from './pathSecurity'
import { defaultPdfSavePath, getFileMetadata, readFileForViewer } from './fileReadHelpers'
import { SessionBackupManager } from './sessionBackupManager'
import { getMainWindow } from './windowRef'
import { submitToolConfirmResponse, signalToolCancel } from './toolConfirmRegistry'
import { spawn } from 'child_process'

const CONFIG_KEYS = {
  baseUrl: 'config.baseUrl',
  model: 'config.model',
  temperature: 'config.temperature',
  maxTokens: 'config.maxTokens',
  defaultModel: 'config.defaultModel',
  models: 'config.models',
  thinkingEnabled: 'config.thinkingEnabled',
  workDir: 'config.workDir',
  apiKeyEnc: 'secrets.apiKeyEnc',
  tools: 'config.tools'
} as const

export type AppIpcContext = {
  db: AppDatabase
  backup: SessionBackupManager
  getWorkDir: () => string
  setWorkDir: (dir: string) => void
  getApiKey: () => Promise<string | null>
  setApiKey: (value: string) => Promise<void>
}

async function syncBackup(ctx: AppIpcContext, sessionId: string): Promise<void> {
  const s = getSession(ctx.db, sessionId)
  if (!s) return
  const msgs = getMessages(ctx.db, sessionId, 10_000, 0)
  await ctx.backup.backupSession(s, msgs)
}

export function registerAppIpcHandlers(ipcMain: IpcMain, ctx: AppIpcContext): void {
  ipcMain.handle(
    'tool:confirm-response',
    async (_e, payload: { requestId: string; toolUseId: string; approved: boolean }): Promise<void> => {
      submitToolConfirmResponse(payload.requestId, payload.toolUseId, payload.approved)
    }
  )

  ipcMain.handle('tool:cancel', async (_e, payload: { requestId: string; toolUseId: string }): Promise<void> => {
    signalToolCancel(payload.requestId, payload.toolUseId)
  })

  ipcMain.handle(
    'tool:test-interpreter',
    async (_e, payload: { path: string }): Promise<{ ok: true; version: string } | { ok: false; error: string }> => {
      const py = typeof payload.path === 'string' && payload.path.trim() ? payload.path.trim() : 'python'
      return await new Promise((resolve) => {
        const proc = spawn(py, ['--version'], { windowsHide: true, shell: false })
        let out = ''
        proc.stdout?.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        proc.stderr?.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        proc.on('error', (err) => {
          resolve({ ok: false, error: err.message })
        })
        proc.on('close', (code) => {
          const v = out.trim()
          if (code === 0 && v) resolve({ ok: true, version: v })
          else resolve({ ok: false, error: v || `进程退出码 ${code}` })
        })
      })
    }
  )

  ipcMain.handle('session:list', (): Session[] => listSessions(ctx.db))

  ipcMain.handle(
    'session:create',
    async (_e, payload: { name: string; model?: string; temperature?: number; maxTokens?: number }): Promise<Session> => {
      const s = createSession(ctx.db, payload)
      await fs.mkdir(ctx.getWorkDir(), { recursive: true })
      await ctx.backup.backupSession(s, [])
      return s
    }
  )

  ipcMain.handle('session:get', (_e, sessionId: string): Session | undefined => getSession(ctx.db, sessionId))

  ipcMain.handle(
    'session:update',
    async (_e, payload: { sessionId: string; name?: string; temperature?: number; maxTokens?: number }): Promise<Session | undefined> => {
      const cur = getSession(ctx.db, payload.sessionId)
      if (!cur) return undefined
      const next = updateSession(ctx.db, payload.sessionId, {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
        ...(payload.maxTokens !== undefined ? { maxTokens: payload.maxTokens } : {})
      })
      if (next) await syncBackup(ctx, next.id)
      return next
    }
  )

  ipcMain.handle('session:delete', async (_e, sessionId: string): Promise<void> => {
    const s = getSession(ctx.db, sessionId)
    deleteSession(ctx.db, sessionId)
    if (s) await ctx.backup.deleteBackup(s)
  })

  ipcMain.handle(
    'chat:get-messages',
    (_e, payload: { sessionId: string; limit?: number; offset?: number }): Message[] =>
      getMessages(ctx.db, payload.sessionId, payload.limit ?? 500, payload.offset ?? 0)
  )

  ipcMain.handle(
    'chat:append-message',
    async (_e, msg: Message): Promise<Message> => {
      const m = appendMessage(ctx.db, msg)
      await syncBackup(ctx, m.sessionId)
      return m
    }
  )

  ipcMain.handle(
    'chat:patch-message',
    async (_e, payload: { messageId: string; patch: Partial<Pick<Message, 'content' | 'status' | 'toolUse' | 'thinking' | 'toolCalls'>> } & { sessionId: string }) => {
      updateMessageContent(ctx.db, payload.messageId, payload.patch)
      await syncBackup(ctx, payload.sessionId)
    }
  )

  ipcMain.handle('config:get', async (): Promise<AppConfig> => {
    const wd = getConfigValue(ctx.db, CONFIG_KEYS.workDir) ?? path.join(ctx.getWorkDir())
    const defaultModelName = getConfigValue(ctx.db, CONFIG_KEYS.defaultModel) ?? 'claude-sonnet-4-20250514'
    const modelName = getConfigValue(ctx.db, CONFIG_KEYS.model) ?? 'claude-sonnet-4-20250514'
    let models: ModelEntry[]
    const rawModels = getConfigValue(ctx.db, CONFIG_KEYS.models)
    if (rawModels) {
      try {
        models = JSON.parse(rawModels)
      } catch {
        models = []
      }
    } else {
      models = DEFAULT_MODELS.map((m, i) => ({
        id: String(i + 1),
        ...m
      }))
    }
    const defaultEntry = models.find((m) => m.isDefault)
    let tools: ToolsConfig = mergeToolsConfig(null)
    const toolsRaw = getConfigValue(ctx.db, CONFIG_KEYS.tools)
    if (toolsRaw) {
      try {
        tools = mergeToolsConfig(JSON.parse(toolsRaw) as Partial<ToolsConfig>)
      } catch {
        /* keep default */
      }
    }
    return {
      apiKeyPresent: Boolean(getConfigValue(ctx.db, CONFIG_KEYS.apiKeyEnc)),
      baseUrl: getConfigValue(ctx.db, CONFIG_KEYS.baseUrl) ?? '',
      model: defaultEntry?.name ?? modelName,
      temperature: Number(getConfigValue(ctx.db, CONFIG_KEYS.temperature) ?? 0.7),
      maxTokens: Number(getConfigValue(ctx.db, CONFIG_KEYS.maxTokens) ?? 4096),
      defaultModel: defaultEntry?.name ?? defaultModelName,
      models,
      thinkingEnabled: getConfigValue(ctx.db, CONFIG_KEYS.thinkingEnabled) !== 'false',
      workDir: wd,
      tools
    }
  })

  ipcMain.handle(
    'config:set',
    async (
      _e,
      payload: Partial<{
        baseUrl: string
        model: string
        temperature: number
        maxTokens: number
        defaultModel: string
        models: AppConfig['models']
        thinkingEnabled: boolean
        workDir: string
        apiKey: string
        tools: Partial<ToolsConfig>
      }>
    ): Promise<void> => {
      if (payload.baseUrl !== undefined) setConfigValue(ctx.db, CONFIG_KEYS.baseUrl, payload.baseUrl)
      if (payload.models !== undefined) {
        setConfigValue(ctx.db, CONFIG_KEYS.models, JSON.stringify(payload.models))
        const defaultEntry = payload.models.find((m) => m.isDefault)
        if (defaultEntry) {
          setConfigValue(ctx.db, CONFIG_KEYS.model, defaultEntry.name)
          setConfigValue(ctx.db, CONFIG_KEYS.defaultModel, defaultEntry.name)
        }
      }
      if (payload.temperature !== undefined) setConfigValue(ctx.db, CONFIG_KEYS.temperature, String(payload.temperature))
      if (payload.maxTokens !== undefined) setConfigValue(ctx.db, CONFIG_KEYS.maxTokens, String(payload.maxTokens))
      if (payload.thinkingEnabled !== undefined) setConfigValue(ctx.db, CONFIG_KEYS.thinkingEnabled, String(payload.thinkingEnabled))
      if (payload.workDir !== undefined) {
        setConfigValue(ctx.db, CONFIG_KEYS.workDir, payload.workDir)
        ctx.setWorkDir(payload.workDir)
        await fs.mkdir(payload.workDir, { recursive: true })
      }
      if (payload.apiKey !== undefined && payload.apiKey.trim()) {
        await ctx.setApiKey(payload.apiKey.trim())
      }
      if (payload.tools !== undefined) {
        let cur = mergeToolsConfig(null)
        const curRaw = getConfigValue(ctx.db, CONFIG_KEYS.tools)
        if (curRaw) {
          try {
            cur = mergeToolsConfig(JSON.parse(curRaw) as Partial<ToolsConfig>)
          } catch {
            /* ignore */
          }
        }
        const next = mergeToolsConfig({ ...cur, ...payload.tools })
        setConfigValue(ctx.db, CONFIG_KEYS.tools, JSON.stringify(next))
      }
    }
  )

  ipcMain.handle('config:test-connection', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const apiKey = await ctx.getApiKey()
      if (!apiKey) return { success: false, error: 'API Key 未配置' }
      const baseUrlRaw = getConfigValue(ctx.db, CONFIG_KEYS.baseUrl) ?? undefined
      const baseUrl = assertValidOptionalAnthropicBaseUrl(baseUrlRaw)
      const model = getConfigValue(ctx.db, CONFIG_KEYS.model) ?? 'claude-sonnet-4-20250514'
      const client = createAnthropicClient(apiKey, baseUrl)
      await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }]
      })
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:list-directory', async (_e, rel: string): Promise<FileInfo[]> => {
    const root = ctx.getWorkDir()
    const target = rel === '' || rel === '.' ? root : resolveSafePath(root, rel)
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
        path: path.relative(root, p) || '.',
        isDirectory: ent.isDirectory(),
        size
      })
    }
    return out.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  })

  ipcMain.handle('file:read-file', async (_e, rel: string) => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, rel)
    return readFileForViewer(target)
  })

  ipcMain.handle('file:get-metadata', async (_e, rel: string) => {
    const root = ctx.getWorkDir()
    const target = resolveSafePath(root, rel)
    return getFileMetadata(target)
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
      if (!win) return { ok: false, error: '窗口未就绪' }

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
          code { font-family: Consolas, monospace; font-size: 13px; }
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
      throw new Error('新名称不允许包含路径分隔符')
    }
    const root = ctx.getWorkDir()
    const oldPath = resolveSafePath(root, rel)
    const newPath = path.join(path.dirname(oldPath), newName)
    await fs.rename(oldPath, newPath)
  })

  ipcMain.handle('file:move', async (_e, srcRel: string, destDirRel: string): Promise<void> => {
    const root = ctx.getWorkDir()
    const srcPath = resolveSafePath(root, srcRel)
    const destDirPath = resolveSafePath(root, destDirRel)
    const destStat = await fs.stat(destDirPath)
    if (!destStat.isDirectory()) {
      throw new Error('目标路径不是目录')
    }
    const srcName = path.basename(srcPath)
    await fs.rename(srcPath, path.join(destDirPath, srcName))
  })

  ipcMain.handle('search:execute', async (_e, query: string): Promise<SearchResult[]> => {
    const q = query.trim()
    if (!q) return []
    appendSearchHistory(ctx.db, q)
    const results: SearchResult[] = []
    const qLower = q.toLowerCase()
    const sessionsById = new Map(ctx.db.data.sessions.map((s) => [s.id, s]))
    for (const m of ctx.db.data.messages) {
      if (results.length >= 50) break
      if (!m.content.toLowerCase().includes(qLower)) continue
      const s = sessionsById.get(m.sessionId)
      results.push({
        id: `msg:${m.id}`,
        type: 'session',
        title: s?.name ?? m.sessionId,
        preview: m.content.slice(0, 160),
        sessionId: m.sessionId
      })
    }
    const root = ctx.getWorkDir()
    await searchFilesUnder(root, root, q, results, 0, 40)
    return results
  })

  ipcMain.handle('search:get-history', (): string[] => listSearchHistory(ctx.db))

  ipcMain.handle('dialog:select-directory', async (): Promise<{ path: string } | { canceled: true } | { error: string }> => {
    const win = getMainWindow()
    if (!win) return { error: '窗口未就绪' }
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('config:check-workdir-writable', async (_e, dir: string): Promise<{ writable: boolean; error?: string }> => {
    try {
      await fs.mkdir(dir, { recursive: true })
      const testFile = path.join(dir, `.spaceassistant-write-test-${Date.now()}`)
      await fs.writeFile(testFile, 'test')
      await fs.unlink(testFile)
      return { writable: true }
    } catch (e) {
      return { writable: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

async function searchFilesUnder(
  absRoot: string,
  currentDir: string,
  query: string,
  results: SearchResult[],
  depth: number,
  maxFileHits: number
): Promise<void> {
  if (results.filter((r) => r.type === 'file').length >= maxFileHits || depth > 4) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (results.filter((r) => r.type === 'file').length >= maxFileHits) break
    if (ent.name === 'node_modules' || ent.name === '.git') continue
    const full = path.join(currentDir, ent.name)
    if (ent.isDirectory()) {
      await searchFilesUnder(absRoot, full, query, results, depth + 1, maxFileHits)
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase()
      if (!['.txt', '.md', '.ts', '.tsx', '.json', '.js', '.jsx', '.css', '.html', '.yml', '.yaml'].includes(ext)) continue
      try {
        const raw = await fs.readFile(full, 'utf8')
        if (!raw.toLowerCase().includes(query.toLowerCase())) continue
        const rel = path.relative(absRoot, full)
        const idx = raw.toLowerCase().indexOf(query.toLowerCase())
        const preview = raw.slice(Math.max(0, idx - 40), idx + query.length + 80)
        results.push({
          id: `file:${full}`,
          type: 'file',
          title: rel,
          preview,
          path: rel
        })
      } catch {
        /* binary or unreadable */
      }
    }
  }
}

