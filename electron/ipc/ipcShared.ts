// Phase 2 拆分:模块级共享 helper 与跨域工厂(自 appIpc.ts 纯移动)。
import fs from 'fs/promises'
import path from 'path'
import { AppConfig, Message, SearchResult, Session, SkillsConfig, ToolsConfig } from '../../src/shared/domainTypes'
import { AppDatabase } from '../database'
import { BrowserDetectContext } from '../browser/browserDependencyDetect'
import { ClaudeTurnExecution } from '../claudeStreamHandlers'
import { DebouncedSessionBackupManager } from '../debouncedSessionBackupManager'
import { LLM_SERVICE_CONFIG_KEYS } from '../llmServiceResolver'
import { TurnRuntime } from '../turnRuntime'
import { WikiConfig, FeishuConfig } from '../../src/shared/domainTypes'
import { WorkDirManager } from '../workDirManager'
import { app, shell } from 'electron'
import { detectLocaleFromSystem, isAppLocale } from '../../src/shared/locale'
import { getConfigValue, getMessagesPage, getSession, listSessions, setConfigValue, deleteConfigValue, updateSession } from '../database'
import { getMainWindow } from '../windowRef'
import { getSecurityAuditLog } from '../confirmation/audit'
import { hasPlanMetadataKeys, stripPlanFieldsFromSessionMetadata } from '../../src/shared/planTypes'
import { mergeSkillsConfig, mergeToolsConfig, stripPlanFieldsFromFeishuConfig } from '../../src/shared/domainTypes'
import { mergeWikiConfig, mergeFeishuConfig } from '../../src/shared/domainTypes'
import { readBrowserConfigFromDb } from '../browser/browserConfigDb'
import { readFeishuConfigFromDb } from '../feishu/feishuIpc'
import { readShellConfigFromDb } from '../shell/shellConfigDb'
import { readWeChatConfigFromDb } from '../wechat/weChatIpc'
import { recordSettingsChange } from '../confirmation/settingsAudit'
import { recordSystemManagedCacheEntry } from '../confirmation/decisionCacheWriter'
import { type Dirent } from 'fs'
import { type MessagePageReader } from '../sessionBackupManager'

export async function searchFilesUnder(
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

/**
 * 从 DB 读取 exposure 求值输入（tools/feishu/browser/shell/wechat），与 config:get 同口径。
 */
export function readExposureInputsFromDb(
  db: AppDatabase
): [
  ReturnType<typeof mergeToolsConfig>,
  ReturnType<typeof readFeishuConfigFromDb>,
  ReturnType<typeof readBrowserConfigFromDb>,
  ReturnType<typeof readShellConfigFromDb>,
  ReturnType<typeof readWeChatConfigFromDb>
] {
  let tools = mergeToolsConfig(null)
  const toolsRaw = getConfigValue(db, CONFIG_KEYS.tools)
  if (toolsRaw) {
    try {
      tools = mergeToolsConfig(JSON.parse(toolsRaw) as Partial<ToolsConfig>)
    } catch {
      /* keep default */
    }
  }
  return [
    tools,
    readFeishuConfigFromDb(db),
    readBrowserConfigFromDb(db),
    readShellConfigFromDb(db),
    readWeChatConfigFromDb(db)
  ]
}

export const CONFIG_KEYS = {
  baseUrl: LLM_SERVICE_CONFIG_KEYS.baseUrl,
  model: 'config.model',
  defaultModel: 'config.defaultModel',
  models: 'config.models',
  thinkingEnabled: 'config.thinkingEnabled',
  workDir: 'config.workDir',
  apiKeyEnc: LLM_SERVICE_CONFIG_KEYS.apiKeyEnc,
  llmServices: LLM_SERVICE_CONFIG_KEYS.llmServices,
  activeLlmServiceId: LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId,
  activeLlmServiceIds: LLM_SERVICE_CONFIG_KEYS.activeLlmServiceIds,
  preferredLanguageModelId: LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId,
  preferredFastLanguageModelId: LLM_SERVICE_CONFIG_KEYS.preferredFastLanguageModelId,
  preferredVisionModelId: LLM_SERVICE_CONFIG_KEYS.preferredVisionModelId,
  tools: 'config.tools',
  skills: 'config.skills',
  wiki: 'config.wiki',
  feishu: 'config.feishu',
  wechat: 'config.wechat',
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
  backup: DebouncedSessionBackupManager
  workDirManager: WorkDirManager
  getWorkDir: () => string
  setWorkDir: (dir: string) => void
  getUserDataPath: () => string
  getApiKey: () => Promise<string | null>
  setApiKey: (value: string) => Promise<void>
  getBrowserDetectContext: () => BrowserDetectContext
  floatingNotificationManager?: import('../floatingNotificationManager').FloatingNotificationManager
  turnRuntime?: TurnRuntime
  executeTurn?: ClaudeTurnExecution
  /** P0 托盘常驻前提：管家定时任务依赖「关窗进程存活」，设置页据此提示。 */
  isTrayEnabled?: () => boolean
}

export function stripSessionMetadataAndPersist(db: AppDatabase, session: Session): Session {
  if (!hasPlanMetadataKeys(session.metadata)) return session
  const metadata = stripPlanFieldsFromSessionMetadata(session.metadata ?? {})
  return updateSession(db, session.id, { metadata }) ?? session
}

export function stripAllSessionsAndPersist(db: AppDatabase, options?: { view?: 'all' | 'user-visible' }): Session[] {
  const sessions = listSessions(db, options)
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

export function stripPlanConfigFromDbIfNeeded(db: AppDatabase): void {
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

export function readToolsConfig(db: AppDatabase): ToolsConfig {
  const raw = getConfigValue(db, CONFIG_KEYS.tools)
  if (!raw) return mergeToolsConfig(null)
  try {
    return mergeToolsConfig(JSON.parse(raw) as Partial<ToolsConfig>)
  } catch {
    return mergeToolsConfig(null)
  }
}

export function readSkillsConfig(db: AppDatabase): SkillsConfig {
  const raw = getConfigValue(db, CONFIG_KEYS.skills)
  if (!raw) return mergeSkillsConfig(null)
  try {
    return mergeSkillsConfig(JSON.parse(raw) as Partial<SkillsConfig>)
  } catch {
    return mergeSkillsConfig(null)
  }
}

export function readWikiConfig(db: AppDatabase): WikiConfig {
  const raw = getConfigValue(db, CONFIG_KEYS.wiki)
  if (!raw) return mergeWikiConfig(null)
  try {
    return mergeWikiConfig(JSON.parse(raw) as Partial<WikiConfig>)
  } catch {
    return mergeWikiConfig(null)
  }
}


/** 按 sequence 游标分页读取，不受固定条数上限约束，避免大会话导出被静默截断 */

export function backupPageReader(ctx: AppIpcContext, sessionId: string): MessagePageReader {
  return (afterSequence, pageSize) => getMessagesPage(ctx.db, sessionId, afterSequence, pageSize)
}

export function loadBackupPayload(ctx: AppIpcContext, sessionId: string) {
  const s = getSession(ctx.db, sessionId)
  if (!s) return null
  return { session: s, readPage: backupPageReader(ctx, sessionId) }
}

export function scheduleBackup(ctx: AppIpcContext, sessionId: string): void {
  ctx.backup.schedule(sessionId, async () => loadBackupPayload(ctx, sessionId))
}

export async function flushBackup(ctx: AppIpcContext, sessionId: string): Promise<void> {
  await ctx.backup.flush(sessionId, async () => loadBackupPayload(ctx, sessionId))
}

export const BACKUP_FLUSH_STATUSES = new Set(['completed', 'failed', 'sent'])

export async function backupAfterMessagePatch(
  ctx: AppIpcContext,
  sessionId: string,
  patch: Partial<Pick<Message, 'status'>>
): Promise<void> {
  if (patch.status && BACKUP_FLUSH_STATUSES.has(patch.status)) {
    await flushBackup(ctx, sessionId)
    return
  }
  scheduleBackup(ctx, sessionId)
}

// ---- 跨域 helper 工厂(域文件注入 ctx 后以原名调用,块内调用点保持原样)----

export function makeRecordTrustToCache(ctx: AppIpcContext) {
  return (
    key: import('../../src/shared/confirmation/types').CacheKey,
    sessionId?: string,
    scope: 'session' | 'persistent' = 'persistent'
  ): void => {
    recordSystemManagedCacheEntry({
      db: ctx.db,
      audit: getSecurityAuditLog(),
      lane: 'desktop',
      sessionId: sessionId ?? 'desktop',
      key,
      decision: 'allow',
      scope,
      source: 'user-confirm'
    })
  }
}

export function makeRecordSettings(ctx: AppIpcContext) {
  void ctx
  return (args: {
    kind: 'policy-change' | 'tool-toggle'
    lane: 'desktop' | 'wechat' | 'feishu'
    key: string
    before: unknown
    after: unknown
    reason?: string
  }): void => {
    recordSettingsChange(getSecurityAuditLog(), { ...args, sessionId: 'settings' })
  }
}

export function makePushExposureToolsChanged(ctx: AppIpcContext) {
  return async (lane: 'desktop' | 'wechat' | 'feishu'): Promise<void> => {
    try {
      const { exposedToolNamesForLane } = await import('../toolsConfigRuntime')
      const { loadEffectivePolicyRules } = await import('../confirmation/policyRulesRuntime')
      const tools = exposedToolNamesForLane(
        lane,
        ...readExposureInputsFromDb(ctx.db),
        undefined,
        loadEffectivePolicyRules(ctx.db, lane)
      )
      getMainWindow()?.webContents.send('exposure:tools-changed', { lane, tools })
    } catch {
      /* 重推失败不阻断;渲染端下次 refresh 时补齐 */
    }
  }
}
