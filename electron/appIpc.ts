import fs from 'fs/promises'
import { existsSync, type Dirent } from 'fs'
import path from 'path'
import type { IpcMain } from 'electron'
import { app, BrowserWindow, dialog, shell } from 'electron'
import type { AppDatabase } from './database'
import {
  appendMessage,
  appendSearchHistory,
  createSession,
  deleteSession,
  deleteSessionUsage,
  getConfigValue,
  getMessages,
  getSession,
  getSessionUsage,
  listSearchHistory,
  listSessions,
  setConfigValue,
  deleteConfigValue,
  setSessionUsage,
  updateMessageContent,
  updateSession
} from './database'
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
  SkillRouteRecentMessage,
  SkillRouteResult,
  ToolsConfig
} from '../src/shared/domainTypes'
import { clampMaxParallelChatSessions } from '../src/shared/chatParallelConfig'
import { ErrorCodes } from '../src/shared/errorCodes'
import { DEFAULT_MODELS, mergeSkillsConfig, mergeToolsConfig, normalizeSessionSkillsState, stripPlanFieldsFromAppConfig, stripPlanFieldsFromFeishuConfig } from '../src/shared/domainTypes'
import { hasPlanMetadataKeys, stripPlanFieldsFromSessionMetadata } from '../src/shared/planTypes'
import { logAgentEvent } from './agentLogger/agentLogger'
import { getCachedMemoryState, loadProjectMemory, writeProjectMemory, generateProjectMemory } from './projectMemory'
import { createSkillManager } from './skills/skillManager'
import { ensureSkillsDirs, getProjectSkillsDir, getUserSkillsDir } from './skills/skillPaths'
import { createAnthropicClient } from './anthropicClientFactory'
import { rebuildAppMenu } from './menu'
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
import type { WorkDirManager } from './workDirManager'
import { listSessionsForProfile } from './workDirManager'
import { resolveSafePath } from './pathSecurity'
import { defaultPdfSavePath, getFileMetadata, readFileForViewer } from './fileReadHelpers'
import { buildLocalFileViewerUrl } from './fileViewerUrl'
import { SessionBackupManager } from './sessionBackupManager'
import { getMainWindow } from './windowRef'
import { submitToolConfirmResponse, signalToolCancel } from './toolConfirmRegistry'
import { clearSessionToolResources } from './toolChatLoop'
import { SESSION_META_TITLE_USER_CUSTOM, scheduleSessionTitleOpenBackfillIfNeeded } from './sessionTitleSuggest'
import { spawn } from 'child_process'
import { mergeWikiConfig, mergeFeishuConfig } from '../src/shared/domainTypes'
import type { WikiConfig, WikiStatus, FeishuConfig, BrowserConfig, ShellConfig } from '../src/shared/domainTypes'
import { readBrowserConfigFromDb, persistBrowserConfig } from './browser/browserConfigDb'
import { persistShellConfig, readShellConfigFromDb, syncShellDeniedTools } from './shell/shellConfigDb'
import { stagehandService } from './browser/stagehandService'
import type { BrowserDetectContext } from './browser/browserDependencyDetect'
import { readFeishuConfigFromDb, persistFeishuConfig } from './feishu/feishuIpc'
import { initWikiStructure, readWikiSchema } from './wiki/wikiInit'
import { getWikiStatus } from './wiki/wikiStatus'
import { classifyWikiPath } from './wiki/wikiPaths'
import { copyFileInWorkDir, importRawFromWorkDir } from './wiki/wikiImport'
import { openExternalLink } from './externalLink'
import { detectLocaleFromSystem, isAppLocale } from '../src/shared/locale'

const CONFIG_KEYS = {
  baseUrl: LLM_SERVICE_CONFIG_KEYS.baseUrl,
  model: 'config.model',
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
  feishu: 'config.feishu',
  workDirProfiles: 'config.workDirProfiles',
  activeWorkDirProfileId: 'config.activeWorkDirProfileId',
  maxParallelChatSessions: 'config.maxParallelChatSessions',
  browser: 'config.browser',
  locale: 'config.locale'
} as const

export function readAppLocale(db: AppDatabase): AppConfig['locale'] {
  const stored = getConfigValue(db, CONFIG_KEYS.locale)
  if (stored && isAppLocale(stored)) return stored
  const detected = detectLocaleFromSystem(app.getLocale())
  setConfigValue(db, CONFIG_KEYS.locale, detected)
  return detected
}

export type AppIpcContext = {
  db: AppDatabase
  backup: SessionBackupManager
  workDirManager: WorkDirManager
  getWorkDir: () => string
  setWorkDir: (dir: string) => void
  getUserDataPath: () => string
  getApiKey: () => Promise<string | null>
  setApiKey: (value: string) => Promise<void>
  getBrowserDetectContext: () => BrowserDetectContext
}

function stripSessionMetadataAndPersist(db: AppDatabase, session: Session): Session {
  if (!hasPlanMetadataKeys(session.metadata)) return session
  const metadata = stripPlanFieldsFromSessionMetadata(session.metadata ?? {})
  return updateSession(db, session.id, { metadata }) ?? session
}

function stripAllSessionsAndPersist(db: AppDatabase): Session[] {
  const sessions = listSessions(db)
  let changed = false
  const result = sessions.map((s) => {
    if (!hasPlanMetadataKeys(s.metadata)) return s
    changed = true
    const metadata = stripPlanFieldsFromSessionMetadata(s.metadata ?? {})
    return updateSession(db, s.id, { metadata }) ?? { ...s, metadata }
  })
  if (changed) db.flushSave()
  return result
}

function stripPlanConfigFromDbIfNeeded(db: AppDatabase): void {
  deleteConfigValue(db, 'config.defaultChatMode')
  deleteConfigValue(db, 'config.plan')
  const feishuRaw = getConfigValue(db, CONFIG_KEYS.feishu)
  if (!feishuRaw) return
  try {
    const parsed = mergeFeishuConfig(JSON.parse(feishuRaw) as Partial<FeishuConfig>)
    if (!('remotePlanMode' in parsed) && !('remotePlanKeywords' in parsed)) return
    const stripped = stripPlanFieldsFromFeishuConfig(parsed)
    setConfigValue(db, CONFIG_KEYS.feishu, JSON.stringify(stripped))
  } catch {
    /* ignore */
  }
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

  ipcMain.handle(
    'tool:confirm-response',
    async (
      _e,
      payload: {
        requestId: string
        toolUseId: string
        approved: boolean
        trustCommand?: string
        trustDomain?: string
      }
    ): Promise<void> => {
      if (payload.approved && payload.trustCommand?.trim()) {
        const { addTrustedCommand } = await import('./shell/shellCommandTrust')
        addTrustedCommand(ctx.db, payload.trustCommand.trim())
        logAgentEvent('info', 'shell.trust.command', {
          command: payload.trustCommand.trim(),
          timestamp: Date.now()
        })
      }
      if (payload.approved && payload.trustDomain?.trim()) {
        const { addTrustedDomain } = await import('./browser/browserDomainTrust')
        const browser = readBrowserConfigFromDb(ctx.db)
        const next = addTrustedDomain(browser, payload.trustDomain.trim())
        persistBrowserConfig(ctx.db, next)
        logAgentEvent('info', 'browser.trust.domain', {
          domain: payload.trustDomain.trim(),
          timestamp: Date.now()
        })
      }
      submitToolConfirmResponse(payload.requestId, payload.toolUseId, payload.approved)
    }
  )

  ipcMain.handle('shell:manage-trusted-commands', async (_e, payload: unknown) => {
    const { listTrustedCommands, addTrustedCommand, removeTrustedCommands, cleanExpiredTrustedCommands } =
      await import('./shell/shellCommandTrust')
    const action = payload && typeof payload === 'object' ? (payload as { action?: string }).action : ''
    try {
      if (action === 'list') {
        return { ok: true as const, commands: listTrustedCommands(ctx.db) }
      }
      if (action === 'add' && typeof (payload as { command?: string }).command === 'string') {
        addTrustedCommand(ctx.db, (payload as { command: string }).command)
        return { ok: true as const, commands: listTrustedCommands(ctx.db) }
      }
      if (action === 'remove' && Array.isArray((payload as { ids?: string[] }).ids)) {
        const ids = (payload as { ids: string[] }).ids
        const before = listTrustedCommands(ctx.db)
        const removed = before.filter((c) => ids.includes(c.id))
        const commands = removeTrustedCommands(ctx.db, ids)
        for (const item of removed) {
          logAgentEvent('info', 'trust.remove', {
            type: 'shell_command',
            item: item.command,
            timestamp: Date.now()
          })
        }
        return { ok: true as const, commands }
      }
      if (action === 'cleanExpired') {
        cleanExpiredTrustedCommands(ctx.db)
        return { ok: true as const, commands: listTrustedCommands(ctx.db) }
      }
      return { ok: false as const, error: 'invalid action' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false as const, error: message }
    }
  })

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
          else resolve({ ok: false, error: v || `${ErrorCodes.SHELL_PROCESS_EXIT_CODE}|${code ?? ''}` })
        })
      })
    }
  )

  ipcMain.handle(
    'shell:test-executable',
    async (
      _e,
      payload: { executable?: string; argsPrefix?: string[] }
    ): Promise<{ ok: boolean; error?: string }> => {
      const { testShellExecutable } = await import('./tools/runShellExecutor')
      const exe = typeof payload.executable === 'string' ? payload.executable.trim() : ''
      if (!exe) return { ok: false, error: ErrorCodes.SHELL_EXECUTABLE_REQUIRED }
      return testShellExecutable(exe, payload.argsPrefix, ctx.getWorkDir())
    }
  )

  ipcMain.handle(
    'shell:open-output-path',
    async (_e, absPath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const target = typeof absPath === 'string' ? absPath.trim() : ''
      if (!target) return { ok: false, error: ErrorCodes.INVALID_PATH }
      const err = await shell.openPath(target)
      return err ? { ok: false, error: err } : { ok: true }
    }
  )

  ipcMain.handle(
    'shell:open-terminal',
    async (_e, payload: { cwd?: string }): Promise<{ ok: true } | { ok: false; error: string }> => {
      const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : ctx.getWorkDir()
      const { openTerminalAtCwd } = await import('./browser/openTerminalAtCwd')
      return openTerminalAtCwd(cwd, ctx.getBrowserDetectContext(), { allowedWorkDir: ctx.getWorkDir() })
    }
  )

  ipcMain.handle('browser:detect', async (_e, force?: boolean) => {
    stagehandService.configureDetectContext(ctx.getBrowserDetectContext())
    return stagehandService.detectDependencies(force === true)
  })

  ipcMain.handle('browser:open-terminal', async () => {
    stagehandService.configureDetectContext(ctx.getBrowserDetectContext())
    const detect = await stagehandService.detectDependencies(true)
    const { openTerminalAtCwd } = await import('./browser/openTerminalAtCwd')
    return openTerminalAtCwd(detect.recommendedCwd, ctx.getBrowserDetectContext())
  })

  ipcMain.handle('session:list', (): Session[] => {
    const profileId = ctx.workDirManager.getActiveProfileId()
    return stripAllSessionsAndPersist(ctx.db).filter((s) => {
      if (!s.workDirProfileId) return false
      return s.workDirProfileId === profileId
    })
  })

  ipcMain.handle(
    'session:create',
    async (
      _e,
      payload: { name: string; model?: string; temperature?: number; maxTokens?: number; metadata?: Record<string, unknown> }
    ): Promise<Session> => {
      const s = createSession(ctx.db, {
        ...payload,
        workDirProfileId: ctx.workDirManager.getActiveProfileId()
      })
      await fs.mkdir(ctx.getWorkDir(), { recursive: true })
      await ctx.backup.backupSession(s, [])
      return s
    }
  )

  ipcMain.handle('session:get', (_e, sessionId: string): Session | undefined => {
    const session = getSession(ctx.db, sessionId)
    if (!session) return undefined
    return stripSessionMetadataAndPersist(ctx.db, session)
  })

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
      const trimmedName = payload.name !== undefined ? payload.name.trim() : undefined
      const nameChanged =
        payload.name !== undefined &&
        trimmedName !== '' &&
        trimmedName !== (cur.name ?? '').trim()
      if (nameChanged) {
        mergedMetadata[SESSION_META_TITLE_USER_CUSTOM] = true
      }
      const hasMetaChange = payload.metadata !== undefined || nameChanged
      const next = updateSession(ctx.db, payload.sessionId, {
        ...(nameChanged && trimmedName !== undefined ? { name: trimmedName } : {}),
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
    'usage:set',
    (_e, payload: { sessionId: string; usage: import('../src/shared/sessionUsage').SessionUsage }): void => {
      setSessionUsage(ctx.db, payload.sessionId, payload.usage)
    }
  )

  ipcMain.handle(
    'usage:get',
    (_e, sessionId: string): import('../src/shared/sessionUsage').SessionUsage | undefined =>
      getSessionUsage(ctx.db, sessionId)
  )

  ipcMain.handle('usage:delete', (_e, sessionId: string): void => {
    deleteSessionUsage(ctx.db, sessionId)
    ctx.db.save()
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
    async (_e, payload: { messageId: string; patch: Partial<Pick<Message, 'content' | 'status' | 'toolUse' | 'thinking' | 'toolCalls' | 'contentSegments' | 'skillHints'>> } & { sessionId: string }) => {
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
    const feishu = readFeishuConfigFromDb(ctx.db)
    let workDirProfiles: AppConfig['workDirProfiles'] = []
    const profilesRaw = getConfigValue(ctx.db, CONFIG_KEYS.workDirProfiles)
    if (profilesRaw) {
      try {
        workDirProfiles = JSON.parse(profilesRaw) as AppConfig['workDirProfiles']
      } catch {
        workDirProfiles = []
      }
    }
    if (workDirProfiles.length === 0 && wd) {
      workDirProfiles = [
        {
          id: 'default',
          name: '工作目录',
          path: wd,
          isDefault: true
        }
      ]
    }
    const activeWorkDirProfileId =
      getConfigValue(ctx.db, CONFIG_KEYS.activeWorkDirProfileId) ?? workDirProfiles.find((p) => p.isDefault)?.id ?? 'default'
    const maxParallelRaw = getConfigValue(ctx.db, CONFIG_KEYS.maxParallelChatSessions)
    const browser = readBrowserConfigFromDb(ctx.db)
    const shell = readShellConfigFromDb(ctx.db)
    const locale = readAppLocale(ctx.db)
    stripPlanConfigFromDbIfNeeded(ctx.db)
    return stripPlanFieldsFromAppConfig({
      locale,
      apiKeyPresent: activeService?.apiKeyPresent ?? Boolean(getConfigValue(ctx.db, CONFIG_KEYS.apiKeyEnc)),
      baseUrl: activeService?.baseUrl ?? getConfigValue(ctx.db, CONFIG_KEYS.baseUrl) ?? '',
      llmServices,
      activeLlmServiceId,
      model: defaultEntry?.name ?? modelName,
      defaultModel: defaultEntry?.name ?? defaultModelName,
      models,
      thinkingEnabled: getConfigValue(ctx.db, CONFIG_KEYS.thinkingEnabled) !== 'false',
      workDir: wd,
      maxParallelChatSessions: clampMaxParallelChatSessions(maxParallelRaw ? Number(maxParallelRaw) : undefined),
      tools,
      skills,
      wiki,
      feishu,
      workDirProfiles,
      activeWorkDirProfileId,
      browser,
      shell
    } as AppConfig)
  })

  ipcMain.handle(
    'config:set',
    async (
      _e,
      payload: Partial<{
        baseUrl: string
        model: string
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
        feishu: Partial<FeishuConfig>
        workDirProfiles: AppConfig['workDirProfiles']
        activeWorkDirProfileId: string
        maxParallelChatSessions: number
        browser: Partial<BrowserConfig>
        shell: Partial<ShellConfig>
        locale: AppConfig['locale']
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
        if (
          payload.tools.confirmMode !== undefined &&
          payload.tools.confirmMode !== cur.confirmMode
        ) {
          logAgentEvent('info', 'file.confirm_mode.change', {
            from: cur.confirmMode,
            to: payload.tools.confirmMode,
            timestamp: Date.now()
          })
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
      if (payload.feishu !== undefined) {
        persistFeishuConfig(ctx.db, payload.feishu)
      }
      if (payload.workDirProfiles !== undefined) {
        const validation = ctx.workDirManager.validateProfilesForSave(payload.workDirProfiles)
        if (!validation.valid) {
          throw new Error(validation.error ?? '工作目录配置无效')
        }
        const activeId =
          payload.activeWorkDirProfileId ??
          payload.workDirProfiles.find((p) => p.isDefault)?.id ??
          payload.workDirProfiles[0]?.id ??
          ''
        ctx.workDirManager.persistProfiles(payload.workDirProfiles, activeId)
      }
      if (payload.activeWorkDirProfileId !== undefined && payload.workDirProfiles === undefined) {
        setConfigValue(ctx.db, CONFIG_KEYS.activeWorkDirProfileId, payload.activeWorkDirProfileId)
      }
      if (payload.maxParallelChatSessions !== undefined) {
        setConfigValue(
          ctx.db,
          CONFIG_KEYS.maxParallelChatSessions,
          String(clampMaxParallelChatSessions(payload.maxParallelChatSessions))
        )
      }
      if (payload.browser !== undefined) {
        if (payload.browser.trustedDomains !== undefined) {
          const prevBrowser = readBrowserConfigFromDb(ctx.db)
          const prevSet = new Set((prevBrowser.trustedDomains ?? []).map((d) => d.toLowerCase()))
          const nextSet = new Set(
            (payload.browser.trustedDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)
          )
          for (const domain of prevSet) {
            if (!nextSet.has(domain)) {
              logAgentEvent('info', 'trust.remove', {
                type: 'browser_domain',
                item: domain,
                timestamp: Date.now()
              })
            }
          }
        }
        persistBrowserConfig(ctx.db, payload.browser)
      }
      if (payload.shell !== undefined) {
        const nextShell = persistShellConfig(ctx.db, payload.shell)
        let curTools = mergeToolsConfig(null)
        const curToolsRaw = getConfigValue(ctx.db, CONFIG_KEYS.tools)
        if (curToolsRaw) {
          try {
            curTools = mergeToolsConfig(JSON.parse(curToolsRaw) as Partial<ToolsConfig>)
          } catch {
            /* ignore */
          }
        }
        const deniedTools = syncShellDeniedTools(nextShell, curTools.deniedTools)
        setConfigValue(
          ctx.db,
          CONFIG_KEYS.tools,
          JSON.stringify(mergeToolsConfig({ ...curTools, deniedTools }))
        )
      }
      if (payload.locale !== undefined && isAppLocale(payload.locale)) {
        setConfigValue(ctx.db, CONFIG_KEYS.locale, payload.locale)
        rebuildAppMenu(payload.locale)
      }
      stripPlanConfigFromDbIfNeeded(ctx.db)
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
          return { success: false, error: creds.error ?? ErrorCodes.API_KEY_NOT_CONFIGURED }
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
            error: ErrorCodes.NO_ENABLED_MODEL
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
      throw new Error(ErrorCodes.NAME_CONTAINS_PATH_SEPARATOR)
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
      throw new Error(ErrorCodes.TARGET_NOT_DIRECTORY)
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
        sessionId: m.sessionId,
        messageId: m.id
      })
    }
    const root = ctx.getWorkDir()
    await searchFilesUnder(root, root, q, results, 0, 40)
    return results
  })

  ipcMain.handle('search:get-history', (): string[] => listSearchHistory(ctx.db))

  ipcMain.handle('dialog:select-directory', async (): Promise<{ path: string } | { canceled: true } | { error: string }> => {
    const win = getMainWindow()
    if (!win) return { error: ErrorCodes.WINDOW_NOT_READY }
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
    async (_e, payload: { userInput: string; sessionSkillsState: SessionSkillsState; sessionMetadata?: Record<string, unknown> }): Promise<SkillDefinition[]> => {
      const matched = skillManager.match(
        payload.userInput,
        normalizeSessionSkillsState(payload.sessionSkillsState),
        payload.sessionMetadata
      )
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
    'skill:route',
    async (
      _e,
      payload: {
        userInput: string
        sessionSkillsState: SessionSkillsState
        sessionId?: string
        sessionMetadata?: Record<string, unknown>
        recentMessages?: SkillRouteRecentMessage[]
        model?: string
      }
    ): Promise<SkillRouteResult> => {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : undefined
      const session = sessionId ? getSession(ctx.db, sessionId) : undefined
      const modelName =
        (typeof payload.model === 'string' && payload.model.trim()) ||
        session?.model ||
        getConfigValue(ctx.db, CONFIG_KEYS.model) ||
        'claude-sonnet-4-20250514'
      const baseUrlRaw = getConfigValue(ctx.db, CONFIG_KEYS.baseUrl) ?? undefined
      const baseUrl = assertValidOptionalAnthropicBaseUrl(baseUrlRaw)

      const result = await skillManager.route({
        userInput: payload.userInput,
        sessionState: normalizeSessionSkillsState(payload.sessionSkillsState),
        sessionMetadata: payload.sessionMetadata ?? session?.metadata,
        recentMessages: payload.recentMessages,
        model: modelName,
        baseUrl,
        getApiKey: ctx.getApiKey,
        sessionId
      })

      if (result.skills.length > 0) {
        const systemPrompt = skillManager.buildSystemPrompt(result.skills)
        logAgentEvent('info', 'skills.invoke', {
          skillNames: result.skills.map((s) => s.meta.name),
          systemPromptLength: systemPrompt.length,
          sources: result.meta.sources
        })
      }

      return result
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

  ipcMain.handle(
    'skill:install-from-url',
    async (
      _e,
      payload: { sourceUrl: string; subPath?: string; installAll?: boolean; overwrite?: boolean }
    ): Promise<{ ok: true; skills: SkillDefinition[] } | { ok: false; error: string }> => {
      try {
        const skills = await skillManager.installFromUrl(payload.sourceUrl, {
          subPath: payload.subPath,
          installAll: payload.installAll === true,
          overwrite: payload.overwrite === true
        })
        return { ok: true, skills }
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
    if (!dir) throw new Error(ErrorCodes.WORK_DIR_NOT_CONFIGURED)
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

  ipcMain.handle('project-memory:get-state', async () => {
    return getCachedMemoryState()
  })

  ipcMain.handle('project-memory:reload', async () => {
    const workDir = ctx.getWorkDir()
    const state = await loadProjectMemory(workDir)
    return state
  })

  ipcMain.handle('project-memory:write', async (_event, payload: { content: string }) => {
    try {
      const workDir = ctx.getWorkDir()
      await writeProjectMemory(workDir, payload.content)
      return { success: true as const }
    } catch (err) {
      return { success: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('project-memory:generate', async () => {
    try {
      const workDir = ctx.getWorkDir()

      // Check if file already exists
      const memoryPath = path.join(workDir, 'SPACEASSISTANT.md')
      if (existsSync(memoryPath)) {
        return { success: false as const, error: ErrorCodes.PROJECT_MEMORY_ALREADY_EXISTS }
      }

      const prompt = await generateProjectMemory(workDir)

      const apiKey = await ctx.getApiKey()
      if (!apiKey) {
        return { success: false as const, error: ErrorCodes.API_KEY_NOT_CONFIGURED }
      }

      const client = createAnthropicClient(apiKey, undefined)

      const model =
        (getConfigValue(ctx.db, CONFIG_KEYS.defaultModel) as string) ?? 'claude-sonnet-4-20250514'

      const res = await client.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user' as const, content: prompt }]
      })

      const content = res.content[0]?.type === 'text' ? res.content[0].text : ''
      if (!content) {
        return { success: false as const, error: ErrorCodes.LLM_EMPTY_RESPONSE }
      }

      await writeProjectMemory(workDir, content)

      return { success: true as const, prompt, content }
    } catch (err) {
      return { success: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('workdir:list', () => ctx.workDirManager.listProfiles())

  ipcMain.handle(
    'workdir:add',
    (_e, profile: { name: string; path: string; aliases?: string[]; isDefault?: boolean }) =>
      ctx.workDirManager.addProfile(profile)
  )

  ipcMain.handle(
    'workdir:update',
    (_e, payload: { profileId: string; updates: Partial<import('../src/shared/feishuTypes').WorkDirProfile> }) =>
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

