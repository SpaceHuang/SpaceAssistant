import fs from 'fs/promises'
import type { Dirent } from 'fs'
import path from 'path'
import type { IpcMain } from 'electron'
import { BrowserWindow, dialog, shell } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_UI_THEME } from '../src/shared/domainTypes'
import type {
  AppConfig,
  FileInfo,
  LlmServiceProfile,
  Message,
  ModelEntry,
  SearchResult,
  Session,
  SessionSkillsState,
  SkillDefinition,
  SkillsConfig,
  ToolsConfig,
  UiThemeMode
} from '../src/shared/domainTypes'
import { clampMaxParallelChatSessions } from '../src/shared/chatParallelConfig'
import { DEFAULT_MODELS, mergeSkillsConfig, mergeToolsConfig, normalizeSessionSkillsState } from '../src/shared/domainTypes'
import { DEFAULT_CHAT_MODE, isChatMode } from '../src/shared/planTypes'
import {
  approvePlanInSession,
  cancelPlanInSession,
  dismissPlanAbortInSession,
  readPlanStateForSession,
  rejectPlanInSession
} from './plan/planManager'
import { resumePlanExecution } from './plan/planOrchestrator'
import { logAgentEvent } from './agentLogger/agentLogger'
import { createSkillManager } from './skills/skillManager'
import { ensureSkillsDirs, getProjectSkillsDir, getUserSkillsDir } from './skills/skillPaths'
import { createAnthropicClient } from './anthropicClientFactory'
import { assertValidOptionalAnthropicBaseUrl } from './claudeRequestGuards'
import {
  LlmServiceValidationError,
  LLM_SERVICE_CONFIG_KEYS,
  migrateLegacyLlmServicesIfNeeded,
  persistLlmServices,
  readActiveLlmServiceId,
  readLlmServices,
  resolveTestConnectionCredentials,
  resolveTestConnectionModel
} from './llmServiceResolver'
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
import { clearSessionToolResources } from './toolChatLoop'
import { SESSION_META_TITLE_USER_CUSTOM, scheduleSessionTitleOpenBackfillIfNeeded } from './sessionTitleSuggest'
import { spawn } from 'child_process'
import { mergeWikiConfig } from '../src/shared/domainTypes'
import type { WikiConfig, WikiStatus } from '../src/shared/domainTypes'
import { initWikiStructure, readWikiSchema } from './wiki/wikiInit'
import { getWikiStatus } from './wiki/wikiStatus'
import { classifyWikiPath } from './wiki/wikiPaths'
import { copyFileInWorkDir, importRawFromWorkDir } from './wiki/wikiImport'

const CONFIG_KEYS = {
  baseUrl: LLM_SERVICE_CONFIG_KEYS.baseUrl,
  model: 'config.model',
  temperature: 'config.temperature',
  maxTokens: 'config.maxTokens',
  defaultModel: 'config.defaultModel',
  models: 'config.models',
  thinkingEnabled: 'config.thinkingEnabled',
  workDir: 'config.workDir',
  apiKeyEnc: LLM_SERVICE_CONFIG_KEYS.apiKeyEnc,
  llmServices: LLM_SERVICE_CONFIG_KEYS.llmServices,
  activeLlmServiceId: LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId,
  tools: 'config.tools',
  skills: 'config.skills',
  wiki: 'config.wiki',
  uiTheme: 'config.uiTheme',
  maxParallelChatSessions: 'config.maxParallelChatSessions',
  defaultChatMode: 'config.defaultChatMode'
} as const

export type AppIpcContext = {
  db: AppDatabase
  backup: SessionBackupManager
  getWorkDir: () => string
  setWorkDir: (dir: string) => void
  getUserDataPath: () => string
  getApiKey: () => Promise<string | null>
  setApiKey: (value: string) => Promise<void>
}

function readToolsConfig(db: AppDatabase): ToolsConfig {
  const raw = getConfigValue(db, CONFIG_KEYS.tools)
  if (!raw) return mergeToolsConfig(null)
  try {
    return mergeToolsConfig(JSON.parse(raw) as Partial<ToolsConfig>)
  } catch {
    return mergeToolsConfig(null)
  }
}

function readSkillsConfig(db: AppDatabase): SkillsConfig {
  const raw = getConfigValue(db, CONFIG_KEYS.skills)
  if (!raw) return mergeSkillsConfig(null)
  try {
    return mergeSkillsConfig(JSON.parse(raw) as Partial<SkillsConfig>)
  } catch {
    return mergeSkillsConfig(null)
  }
}

function readWikiConfig(db: AppDatabase): WikiConfig {
  const raw = getConfigValue(db, CONFIG_KEYS.wiki)
  if (!raw) return mergeWikiConfig(null)
  try {
    return mergeWikiConfig(JSON.parse(raw) as Partial<WikiConfig>)
  } catch {
    return mergeWikiConfig(null)
  }
}

async function syncBackup(ctx: AppIpcContext, sessionId: string): Promise<void> {
  const s = getSession(ctx.db, sessionId)
  if (!s) return
  const msgs = getMessages(ctx.db, sessionId, 10_000, 0)
  await ctx.backup.backupSession(s, msgs)
}

export function registerAppIpcHandlers(ipcMain: IpcMain, ctx: AppIpcContext): void {
  const skillManager = createSkillManager({
    getUserDataPath: ctx.getUserDataPath,
    getWorkDir: ctx.getWorkDir,
    getSkillsConfig: () => readSkillsConfig(ctx.db),
    getWikiConfig: () => readWikiConfig(ctx.db)
  })
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
    'session:backfill-auto-title-if-needed',
    async (event, payload: { sessionId: string }): Promise<Session | undefined> => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (!sessionId) return undefined
      const baseUrlRaw = getConfigValue(ctx.db, CONFIG_KEYS.baseUrl) ?? undefined
      const baseUrl = assertValidOptionalAnthropicBaseUrl(baseUrlRaw)
      const next = scheduleSessionTitleOpenBackfillIfNeeded({
        db: ctx.db,
        sender: event.sender,
        sessionId,
        baseUrl,
        getApiKey: ctx.getApiKey
      })
      if (next) await syncBackup(ctx, next.id)
      return next
    }
  )

  ipcMain.handle(
    'session:update',
    async (
      _e,
      payload: {
        sessionId: string
        name?: string
        temperature?: number
        maxTokens?: number
        skillsState?: SessionSkillsState
        metadata?: Record<string, unknown>
      }
    ): Promise<Session | undefined> => {
      const cur = getSession(ctx.db, payload.sessionId)
      if (!cur) return undefined
      const mergedMetadata: Record<string, unknown> = { ...cur.metadata }
      if (payload.metadata !== undefined) {
        Object.assign(mergedMetadata, payload.metadata)
      }
      if (payload.name !== undefined) {
        mergedMetadata[SESSION_META_TITLE_USER_CUSTOM] = true
      }
      const hasMetaChange = payload.metadata !== undefined || payload.name !== undefined
      const next = updateSession(ctx.db, payload.sessionId, {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
        ...(payload.maxTokens !== undefined ? { maxTokens: payload.maxTokens } : {}),
        ...(payload.skillsState !== undefined ? { skillsState: normalizeSessionSkillsState(payload.skillsState) } : {}),
        ...(hasMetaChange ? { metadata: mergedMetadata } : {})
      })
      if (next) await syncBackup(ctx, next.id)
      return next
    }
  )

  ipcMain.handle('session:delete', async (_e, sessionId: string): Promise<void> => {
    const s = getSession(ctx.db, sessionId)
    clearSessionToolResources(sessionId)
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
    migrateLegacyLlmServicesIfNeeded(ctx.db)
    const llmServices = readLlmServices(ctx.db)
    const activeLlmServiceId = readActiveLlmServiceId(ctx.db) ?? llmServices[0]?.id ?? ''
    const activeService = llmServices.find((s) => s.id === activeLlmServiceId) ?? llmServices[0]

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
    const skills = readSkillsConfig(ctx.db)
    const wiki = readWikiConfig(ctx.db)
    const uiThemeRaw = getConfigValue(ctx.db, CONFIG_KEYS.uiTheme) as UiThemeMode | undefined
    const uiTheme: UiThemeMode =
      uiThemeRaw === 'light' || uiThemeRaw === 'dark' || uiThemeRaw === 'system' ? uiThemeRaw : DEFAULT_UI_THEME
    const maxParallelRaw = getConfigValue(ctx.db, CONFIG_KEYS.maxParallelChatSessions)
    const defaultChatModeRaw = getConfigValue(ctx.db, CONFIG_KEYS.defaultChatMode)
    const defaultChatMode = isChatMode(defaultChatModeRaw) ? defaultChatModeRaw : DEFAULT_CHAT_MODE
    return {
      apiKeyPresent: activeService?.apiKeyPresent ?? Boolean(getConfigValue(ctx.db, CONFIG_KEYS.apiKeyEnc)),
      baseUrl: activeService?.baseUrl ?? getConfigValue(ctx.db, CONFIG_KEYS.baseUrl) ?? '',
      llmServices,
      activeLlmServiceId,
      model: defaultEntry?.name ?? modelName,
      temperature: Number(getConfigValue(ctx.db, CONFIG_KEYS.temperature) ?? 0.7),
      maxTokens: Number(getConfigValue(ctx.db, CONFIG_KEYS.maxTokens) ?? 4096),
      defaultModel: defaultEntry?.name ?? defaultModelName,
      models,
      thinkingEnabled: getConfigValue(ctx.db, CONFIG_KEYS.thinkingEnabled) !== 'false',
      workDir: wd,
      uiTheme,
      maxParallelChatSessions: clampMaxParallelChatSessions(maxParallelRaw ? Number(maxParallelRaw) : undefined),
      defaultChatMode,
      tools,
      skills,
      wiki
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
        llmServices: LlmServiceProfile[]
        activeLlmServiceId: string
        llmServiceKeys: Record<string, string>
        tools: Partial<ToolsConfig>
        skills: Partial<SkillsConfig>
        wiki: Partial<WikiConfig>
        uiTheme: UiThemeMode
        maxParallelChatSessions: number
        defaultChatMode: import('../src/shared/planTypes').ChatMode
      }>
    ): Promise<void> => {
      try {
        if (payload.llmServices !== undefined && payload.activeLlmServiceId !== undefined) {
          persistLlmServices(ctx.db, payload.llmServices, payload.activeLlmServiceId, payload.llmServiceKeys)
        } else if (payload.apiKey !== undefined && payload.apiKey.trim()) {
          migrateLegacyLlmServicesIfNeeded(ctx.db)
          const activeId = readActiveLlmServiceId(ctx.db) ?? readLlmServices(ctx.db)[0]?.id
          if (activeId) {
            const keys: Record<string, string> = { [activeId]: payload.apiKey.trim() }
            const services = readLlmServices(ctx.db)
            persistLlmServices(ctx.db, services, activeId, keys)
          } else {
            await ctx.setApiKey(payload.apiKey.trim())
          }
        } else if (payload.baseUrl !== undefined) {
          migrateLegacyLlmServicesIfNeeded(ctx.db)
          const services = readLlmServices(ctx.db)
          const activeId = readActiveLlmServiceId(ctx.db) ?? services[0]?.id
          if (activeId && services.length > 0) {
            const updated = services.map((s) =>
              s.id === activeId ? { ...s, baseUrl: payload.baseUrl! } : s
            )
            persistLlmServices(ctx.db, updated, activeId)
          } else {
            setConfigValue(ctx.db, CONFIG_KEYS.baseUrl, payload.baseUrl)
          }
        }
      } catch (e) {
        if (e instanceof LlmServiceValidationError) {
          throw new Error(e.message)
        }
        throw e
      }
      if (payload.baseUrl !== undefined && payload.llmServices === undefined) {
        /* handled above via persist or legacy */
      }
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
      if (payload.apiKey !== undefined && payload.apiKey.trim() && payload.llmServices === undefined) {
        /* legacy apiKey without llmServices handled above */
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
      if (payload.skills !== undefined) {
        let cur = mergeSkillsConfig(null)
        const curRaw = getConfigValue(ctx.db, CONFIG_KEYS.skills)
        if (curRaw) {
          try {
            cur = mergeSkillsConfig(JSON.parse(curRaw) as Partial<SkillsConfig>)
          } catch {
            /* ignore */
          }
        }
        const next = mergeSkillsConfig({ ...cur, ...payload.skills })
        setConfigValue(ctx.db, CONFIG_KEYS.skills, JSON.stringify(next))
      }
      if (payload.wiki !== undefined) {
        let cur = mergeWikiConfig(null)
        const curRaw = getConfigValue(ctx.db, CONFIG_KEYS.wiki)
        if (curRaw) {
          try {
            cur = mergeWikiConfig(JSON.parse(curRaw) as Partial<WikiConfig>)
          } catch {
            /* ignore */
          }
        }
        const next = mergeWikiConfig({ ...cur, ...payload.wiki })
        setConfigValue(ctx.db, CONFIG_KEYS.wiki, JSON.stringify(next))
      }
      if (payload.uiTheme !== undefined) {
        setConfigValue(ctx.db, CONFIG_KEYS.uiTheme, payload.uiTheme)
      }
      if (payload.maxParallelChatSessions !== undefined) {
        setConfigValue(
          ctx.db,
          CONFIG_KEYS.maxParallelChatSessions,
          String(clampMaxParallelChatSessions(payload.maxParallelChatSessions))
        )
      }
      if (payload.defaultChatMode !== undefined && isChatMode(payload.defaultChatMode)) {
        setConfigValue(ctx.db, CONFIG_KEYS.defaultChatMode, payload.defaultChatMode)
      }
      ctx.db.flushSave()
    }
  )

  ipcMain.handle(
    'config:test-connection',
    async (
      _e,
      options?: { serviceId?: string; apiKey?: string; baseUrl?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const creds = await resolveTestConnectionCredentials(ctx.db, options)
        if (creds.error || !creds.apiKey) {
          return { success: false, error: creds.error ?? 'API Key 未配置' }
        }

        const rawModels = getConfigValue(ctx.db, CONFIG_KEYS.models)
        let models: ModelEntry[] = []
        if (rawModels) {
          try {
            models = JSON.parse(rawModels) as ModelEntry[]
          } catch {
            models = []
          }
        }
        const enabledModel = resolveTestConnectionModel(ctx.db, models)
        if (!enabledModel) {
          return {
            success: false,
            error: '请先在默认大模型设置中启用至少一个模型'
          }
        }

        const client = createAnthropicClient(creds.apiKey, creds.baseUrl)
        await client.messages.create({
          model: enabledModel.name,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }]
        })
        return { success: true }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

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

  ipcMain.handle('file:copy', async (_e, payload: { srcRelPath: string; destRelPath: string }): Promise<void> => {
    await copyFileInWorkDir(ctx.getWorkDir(), payload.srcRelPath, payload.destRelPath)
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

  ipcMain.handle('skill:list', async (): Promise<SkillDefinition[]> => skillManager.list(true))

  ipcMain.handle('skill:get', async (_e, payload: { name: string }): Promise<SkillDefinition | null> => {
    return skillManager.get(payload.name)
  })

  ipcMain.handle(
    'skill:match',
    async (_e, payload: { userInput: string; sessionSkillsState: SessionSkillsState }): Promise<SkillDefinition[]> => {
      const matched = skillManager.match(payload.userInput, normalizeSessionSkillsState(payload.sessionSkillsState))
      if (matched.length > 0) {
        const systemPrompt = skillManager.buildSystemPrompt(matched)
        logAgentEvent('info', 'skills.invoke', {
          skillNames: matched.map((s) => s.meta.name),
          systemPromptLength: systemPrompt.length
        })
      }
      return matched
    }
  )

  ipcMain.handle(
    'skill:install',
    async (_e, payload: { sourcePath: string; overwrite?: boolean }): Promise<{ ok: true; skill: SkillDefinition } | { ok: false; error: string }> => {
      try {
        const skill = await skillManager.install(payload.sourcePath, payload.overwrite === true)
        return { ok: true, skill }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('skill:delete', async (_e, payload: { name: string }): Promise<void> => {
    skillManager.delete(payload.name)
  })

  ipcMain.handle('skill:toggle-disable', async (_e, payload: { name: string; disabled: boolean }): Promise<void> => {
    const cur = readSkillsConfig(ctx.db)
    const set = new Set(cur.disabled)
    if (payload.disabled) set.add(payload.name)
    else set.delete(payload.name)
    setConfigValue(ctx.db, CONFIG_KEYS.skills, JSON.stringify({ ...cur, disabled: [...set] }))
  })

  ipcMain.handle('skill:open-directory', async (_e, payload: { scope: 'user' | 'project' }): Promise<void> => {
    ensureSkillsDirs(ctx.getUserDataPath(), ctx.getWorkDir())
    const dir =
      payload.scope === 'project'
        ? getProjectSkillsDir(ctx.getWorkDir())
        : getUserSkillsDir(ctx.getUserDataPath())
    if (!dir) throw new Error('工作目录未配置，无法打开项目级 Skill 目录')
    await shell.openPath(dir)
  })

  ipcMain.handle(
    'skill:export',
    async (_e, payload: { name: string; destPath: string }): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await skillManager.exportSkill(payload.name, payload.destPath)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('plan:read', async (_e, payload: { sessionId: string }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (!sessionId) {
      return {
        plan: null,
        pendingPlan: null,
        displayPlans: [],
        planDrafting: false,
        planAbortDismissed: false,
        abort: null,
        summary: null,
        raw: null
      }
    }
    return await readPlanStateForSession({
      db: ctx.db,
      workDir: ctx.getWorkDir(),
      sessionId
    })
  })

  ipcMain.handle(
    'plan:approve',
    async (event, payload: { sessionId: string; cancelExecuting?: boolean }) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (!sessionId) return { ok: false as const, error: 'Invalid sessionId' }
      try {
        const result = await approvePlanInSession({
          db: ctx.db,
          sessionId,
          workDir: ctx.getWorkDir(),
          cancelExecuting: payload?.cancelExecuting === true
        })
        event.sender.send('plan:state-changed', { sessionId })
        const updated = getSession(ctx.db, sessionId)
        if (updated) await syncBackup(ctx, sessionId)
        return { ok: true as const, plan: result.plan, autoExecute: result.autoExecute }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('plan:reject', async (event, payload: { sessionId: string; feedback?: string }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (!sessionId) return { ok: false as const, error: 'Invalid sessionId' }
    try {
      await rejectPlanInSession({
        db: ctx.db,
        sessionId,
        workDir: ctx.getWorkDir(),
        feedback: typeof payload.feedback === 'string' ? payload.feedback : ''
      })
      event.sender.send('plan:state-changed', { sessionId })
      await syncBackup(ctx, sessionId)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('plan:cancel', async (event, payload: { sessionId: string }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (!sessionId) return { ok: false as const, error: 'Invalid sessionId' }
    try {
      await cancelPlanInSession({ db: ctx.db, sessionId })
      event.sender.send('plan:state-changed', { sessionId })
      await syncBackup(ctx, sessionId)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('plan:dismiss-abort', async (event, payload: { sessionId: string }) => {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    if (!sessionId) return { ok: false as const, error: 'Invalid sessionId' }
    try {
      await dismissPlanAbortInSession({ db: ctx.db, sessionId })
      event.sender.send('plan:state-changed', { sessionId })
      await syncBackup(ctx, sessionId)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('plan:resume-execution', async (event, payload) => {
    const sender = event.sender
    try {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (!requestId || !sessionId) return { ok: false as const, error: 'Invalid payload' }

      const res = await resumePlanExecution({
        sender,
        requestId,
        sessionId,
        model: payload.model,
        baseUrl: payload.baseUrl,
        messages: payload.messages,
        system: payload.system,
        options: payload.options,
        deps: {
          getApiKey: ctx.getApiKey,
          getWorkDir: ctx.getWorkDir,
          getUserDataPath: ctx.getUserDataPath,
          getToolsConfig: () => readToolsConfig(ctx.db),
          getWikiConfig: () => readWikiConfig(ctx.db),
          getAppDatabase: () => ctx.db
        }
      })

      if (!res.ok) return res
      sender.send('claude-chat-done', { requestId })
      return res
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    'wiki:import-raw',
    async (_e, payload: { srcRelPath: string }) => {
      const wikiConfig = readWikiConfig(ctx.db)
      return importRawFromWorkDir(ctx.getWorkDir(), wikiConfig, payload.srcRelPath)
    }
  )

  ipcMain.handle('wiki:init', async (_e, payload: { overwrite?: boolean; installSkill?: boolean } = {}) => {
    const wikiConfig = readWikiConfig(ctx.db)
    const result = await initWikiStructure(ctx.getWorkDir(), wikiConfig, {
      overwrite: payload.overwrite === true,
      installSkill: payload.installSkill !== false
    })
    if (result.ok) skillManager.invalidateCache()
    return result
  })

  ipcMain.handle('wiki:status', async (): Promise<WikiStatus> => {
    const wikiConfig = readWikiConfig(ctx.db)
    return getWikiStatus(ctx.getWorkDir(), wikiConfig)
  })

  ipcMain.handle('wiki:get-schema', async (): Promise<{ content: string } | null> => {
    const wikiConfig = readWikiConfig(ctx.db)
    const content = readWikiSchema(ctx.getWorkDir(), wikiConfig)
    return content ? { content } : null
  })

  ipcMain.handle(
    'wiki:resolve-path',
    async (_e, payload: { relPath: string }): Promise<{ absPath: string; kind: ReturnType<typeof classifyWikiPath> } | { error: string }> => {
      try {
        const wikiConfig = readWikiConfig(ctx.db)
        const root = ctx.getWorkDir()
        const absPath = await resolveSafePath(root, payload.relPath)
        const rel = path.relative(root, absPath).replace(/\\/g, '/')
        return { absPath, kind: classifyWikiPath(root, wikiConfig, rel) }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle('skill:invalidate-cache', async (): Promise<void> => {
    skillManager.invalidateCache()
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

