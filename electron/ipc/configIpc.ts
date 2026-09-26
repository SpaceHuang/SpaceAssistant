import { isThinkingEffort, resolveGlobalThinkingEffort } from '../../src/shared/thinkingEffort'
// Phase 2 拆分:本文件自 appIpc.ts 纯移动而来,通道名与行为不变(driver-authority-refactor Phase 2)。
import fs from 'fs/promises'
import path from 'path'
import type { AppIpcContext } from '../appIpc'
import type { IpcMain } from 'electron'
import { AppConfig, LlmServiceProfile, ModelEntry, SkillsConfig, ToolsConfig } from '../../src/shared/domainTypes'
import { BUILTIN_TOOL_DEFINITIONS } from '../../src/shared/builtinToolDefinitions'
import { CONFIG_KEYS, readAppLocale, stripPlanConfigFromDbIfNeeded, readSkillsConfig, readWikiConfig } from './ipcShared'
import { mergeSkillsConfig, mergeToolsConfig, stripPlanFieldsFromAppConfig } from '../../src/shared/domainTypes'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { FetchServiceModelsResult } from '../../src/shared/llmModelConfig'
import { LlmServiceValidationError, migrateLegacyLlmServicesIfNeeded, migrateMultiServiceModelConfig, persistLlmServices, readActiveLlmServiceId, readActiveLlmServiceIds, readLlmServices, resolveTestConnectionCredentials, resolveTestConnectionModel } from '../llmServiceResolver'
import { WikiConfig, FeishuConfig, WeChatConfig, BrowserConfig, ShellConfig } from '../../src/shared/domainTypes'
import { clampMaxParallelChatSessions } from '../../src/shared/chatParallelConfig'
import { createAnthropicClient } from '../anthropicClientFactory'
import { fetchServiceModels } from '../llmModelListFetcher'
import { getConfigValue, setConfigValue } from '../database'
import { getModelIds, pruneMissingModelsFromServices } from '../../src/shared/llmModelConfig'
import { isAppLocale } from '../../src/shared/locale'
import { isToolEnabledByConfig } from '../toolsConfigRuntime'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { makeRecordSettings, makePushExposureToolsChanged } from './ipcShared'
import { mergeWikiConfig } from '../../src/shared/domainTypes'
import { persistShellConfig, readShellConfigFromDb, syncShellDeniedTools } from '../shell/shellConfigDb'
import { readBrowserConfigFromDb, persistBrowserConfig } from '../browser/browserConfigDb'
import { readFeishuConfigFromDb, persistFeishuConfig } from '../feishu/feishuIpc'
import { readWeChatConfigFromDb, persistWeChatConfig } from '../wechat/weChatIpc'
import { rebuildAppMenu } from '../menu'
import { createHostTranslator } from '../i18n/hostTranslate'
import { rejectPendingConfirmsForToolAcrossLanes } from '../toolConfirmRegistry'
import { revokeToolForAllLanes } from '../toolRevocationRegistry'

export function registerConfigIpc(ipcMain: IpcMain, ctx: AppIpcContext): void {
const recordSettings = makeRecordSettings(ctx)
const pushExposureToolsChanged = makePushExposureToolsChanged(ctx)

  ipcMain.handle('config:get', async (): Promise<AppConfig> => {
    migrateLegacyLlmServicesIfNeeded(ctx.db)

    const wd = ctx.workDirManager.getActiveWorkDir()
    let models: ModelEntry[]
    const rawModels = getConfigValue(ctx.db, CONFIG_KEYS.models)
    if (rawModels) {
      try {
        models = JSON.parse(rawModels) as ModelEntry[]
      } catch {
        models = []
      }
    } else models = []

    const migrated = migrateMultiServiceModelConfig(ctx.db, models)
    models = migrated.models
    const llmServices = migrated.services
    const activeLlmServiceIds = migrated.activeLlmServiceIds
    const activeLlmServiceId = activeLlmServiceIds[0] ?? ''
    const activeService = llmServices.find((s) => s.id === activeLlmServiceId) ?? llmServices[0]

    const languageEntry = models.find((m) => m.id === migrated.preferredLanguageModelId)
    const defaultModelName = languageEntry?.name ?? getConfigValue(ctx.db, CONFIG_KEYS.defaultModel) ?? ''
    const modelName = languageEntry?.name ?? getConfigValue(ctx.db, CONFIG_KEYS.model) ?? defaultModelName
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
    const wechat = readWeChatConfigFromDb(ctx.db)
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
      activeLlmServiceIds,
      model: modelName,
      defaultModel: defaultModelName,
      preferredLanguageModelId: migrated.preferredLanguageModelId,
      preferredFastLanguageModelId: migrated.preferredFastLanguageModelId,
      preferredVisionModelId: migrated.preferredVisionModelId,
      models,
      thinkingEnabled: getConfigValue(ctx.db, CONFIG_KEYS.thinkingEnabled) !== 'false',
      thinkingEffort: resolveGlobalThinkingEffort(
        getConfigValue(ctx.db, CONFIG_KEYS.thinkingEffort),
        getConfigValue(ctx.db, CONFIG_KEYS.thinkingEnabled)
      ),
      workDir: wd,
      maxParallelChatSessions: clampMaxParallelChatSessions(maxParallelRaw ? Number(maxParallelRaw) : undefined),
      tools,
      skills,
      wiki,
      feishu,
      wechat,
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
        thinkingEffort?: import('../../src/shared/agent/invocation').AgentReasoningEffort
        workDir: string
        apiKey: string
        llmServices: LlmServiceProfile[]
        activeLlmServiceId?: string
        activeLlmServiceIds?: string[]
        preferredLanguageModelId?: string
        preferredFastLanguageModelId?: string
        preferredVisionModelId?: string
        llmServiceKeys: Record<string, string>
        tools: Partial<ToolsConfig>
        skills: Partial<SkillsConfig>
        wiki: Partial<WikiConfig>
        feishu: Partial<FeishuConfig>
        wechat: Partial<WeChatConfig>
        workDirProfiles: AppConfig['workDirProfiles']
        activeWorkDirProfileId: string
        maxParallelChatSessions: number
        browser: Partial<BrowserConfig>
        shell: Partial<ShellConfig>
        locale: AppConfig['locale']
      }>
    ): Promise<void> => {
      // §8.4 / 评审 C2:档位校验前置到任何写入之前,非法值整体拒绝、不产生部分写入
      if (payload.thinkingEffort !== undefined && !isThinkingEffort(payload.thinkingEffort)) {
        throw new Error(`无效的 Thinking 强度档位:${String(payload.thinkingEffort)}(允许 off / low / medium / high)`)
      }
      try {
        if (payload.llmServices !== undefined) {
          const activeIds =
            payload.activeLlmServiceIds ??
            (payload.activeLlmServiceId ? [payload.activeLlmServiceId] : readActiveLlmServiceIds(ctx.db))
          persistLlmServices(ctx.db, payload.llmServices, activeIds, payload.llmServiceKeys)
        } else if (payload.apiKey !== undefined && payload.apiKey.trim()) {
          migrateLegacyLlmServicesIfNeeded(ctx.db)
          const activeId = readActiveLlmServiceId(ctx.db) ?? readLlmServices(ctx.db)[0]?.id
          if (activeId) {
            const keys: Record<string, string> = { [activeId]: payload.apiKey.trim() }
            const services = readLlmServices(ctx.db)
            persistLlmServices(ctx.db, services, [activeId], keys)
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
            persistLlmServices(ctx.db, updated, [activeId])
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
        const normalized = payload.models.map((m) => ({ ...m, isDefault: false, enabled: true }))
        setConfigValue(ctx.db, CONFIG_KEYS.models, JSON.stringify(normalized))

        const modelIds = new Set(getModelIds(normalized))
        let services = readLlmServices(ctx.db)
        services = pruneMissingModelsFromServices(services, modelIds)
        const activeIds = readActiveLlmServiceIds(ctx.db)
        for (const id of activeIds) {
          const svc = services.find((s) => s.id === id)
          if (svc && (svc.supportedModelIds?.length ?? 0) === 0) {
            throw new Error(`服务「${svc.name}」须至少支持一个模型`)
          }
        }
        if (services.length > 0) {
          persistLlmServices(ctx.db, services, activeIds.length ? activeIds : [services[0]!.id])
        }

        const preferredId =
          payload.preferredLanguageModelId ??
          getConfigValue(ctx.db, CONFIG_KEYS.preferredLanguageModelId) ??
          ''
        const languageEntry = normalized.find((m) => m.id === preferredId)
        if (languageEntry) {
          setConfigValue(ctx.db, CONFIG_KEYS.model, languageEntry.name)
          setConfigValue(ctx.db, CONFIG_KEYS.defaultModel, languageEntry.name)
        }
      }
      if (payload.preferredLanguageModelId !== undefined) {
        setConfigValue(ctx.db, CONFIG_KEYS.preferredLanguageModelId, payload.preferredLanguageModelId)
        const modelsRaw = getConfigValue(ctx.db, CONFIG_KEYS.models)
        if (modelsRaw) {
          try {
            const models = JSON.parse(modelsRaw) as ModelEntry[]
            const entry = models.find((m) => m.id === payload.preferredLanguageModelId)
            if (entry) {
              setConfigValue(ctx.db, CONFIG_KEYS.model, entry.name)
              setConfigValue(ctx.db, CONFIG_KEYS.defaultModel, entry.name)
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (payload.preferredFastLanguageModelId !== undefined) {
        setConfigValue(ctx.db, CONFIG_KEYS.preferredFastLanguageModelId, payload.preferredFastLanguageModelId)
      }
      if (payload.preferredVisionModelId !== undefined) {
        setConfigValue(ctx.db, CONFIG_KEYS.preferredVisionModelId, payload.preferredVisionModelId)
      }
      if (payload.thinkingEnabled !== undefined) setConfigValue(ctx.db, CONFIG_KEYS.thinkingEnabled, String(payload.thinkingEnabled))
      // 评审 C1:旧键仅为旧客户端兼容保留一个发布周期;新键 thinkingEffort 优先,迁移后此处可删
      if (payload.thinkingEffort !== undefined) setConfigValue(ctx.db, CONFIG_KEYS.thinkingEffort, payload.thinkingEffort)
      if (payload.workDir !== undefined && payload.workDirProfiles === undefined) {
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
        // 这里比较的是全局内置工具配置，而不是桌面暴露清单。
        // 远程 lane 专属的 workdir 工具也必须触发在途请求撤销。
        const beforeNames = new Set(
          BUILTIN_TOOL_DEFINITIONS.filter((tool) => isToolEnabledByConfig(tool.name, cur)).map((tool) => tool.name)
        )
        const afterNames = new Set(
          BUILTIN_TOOL_DEFINITIONS.filter((tool) => isToolEnabledByConfig(tool.name, next)).map((tool) => tool.name)
        )
        for (const toolName of beforeNames) {
          if (afterNames.has(toolName)) continue
          revokeToolForAllLanes(toolName)
          rejectPendingConfirmsForToolAcrossLanes(toolName)
        }
        // §5.6-6：deniedTools 变更落 settings.tool-toggle（含新旧值）
        if (
          payload.tools.deniedTools !== undefined &&
          JSON.stringify(payload.tools.deniedTools) !== JSON.stringify(cur.deniedTools)
        ) {
          recordSettings({
            kind: 'tool-toggle',
            lane: 'desktop',
            key: 'deniedTools',
            before: cur.deniedTools,
            after: payload.tools.deniedTools
          })
        }
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
        // §5.6-6：链路硬约束/确认开关变更落 settings.policy-change（含新旧值）
        const prevFeishu = readFeishuConfigFromDb(ctx.db)
        for (const key of [
          'remoteAllowLocalWrite',
          'remoteDenyOutbound',
          'remoteScriptRequiresConfirm',
          'remoteBrowserNavigateRequiresConfirm',
          'remoteBrowserActRequiresConfirm'
        ] as const) {
          const nextVal = payload.feishu[key]
          if (nextVal !== undefined && nextVal !== prevFeishu[key]) {
            recordSettings({ kind: 'policy-change', lane: 'feishu', key, before: prevFeishu[key], after: nextVal })
          }
        }
        persistFeishuConfig(ctx.db, payload.feishu)
      }
      if (payload.wechat !== undefined) {
        const prevWechat = readWeChatConfigFromDb(ctx.db)
        for (const key of [
          'remoteAllowLocalWrite',
          'remoteDenyOutbound',
          'remoteScriptRequiresConfirm',
          'remoteBrowserNavigateRequiresConfirm',
          'remoteBrowserActRequiresConfirm'
        ] as const) {
          const nextVal = payload.wechat[key]
          if (nextVal !== undefined && nextVal !== prevWechat[key]) {
            recordSettings({ kind: 'policy-change', lane: 'wechat', key, before: prevWechat[key], after: nextVal })
          }
        }
        persistWeChatConfig(ctx.db, payload.wechat)
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
        const prevBrowser = readBrowserConfigFromDb(ctx.db)
        // §5.6-6：浏览器信任域名清单变更落 settings.policy-change（含新旧值）
        for (const key of ['trustedDomains', 'actTrustedDomains'] as const) {
          const nextVal = payload.browser[key]
          if (nextVal !== undefined && JSON.stringify(nextVal) !== JSON.stringify(prevBrowser[key] ?? [])) {
            recordSettings({
              kind: 'policy-change',
              lane: 'desktop',
              key: `browser.${key}`,
              before: prevBrowser[key] ?? [],
              after: nextVal
            })
          }
        }
        if (payload.browser.trustedDomains !== undefined) {
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
        rebuildAppMenu(createHostTranslator({ locale: payload.locale }))
      }
      stripPlanConfigFromDbIfNeeded(ctx.db)
      ctx.db.flushSave()
      // exposure 重推：配置变更后主进程重新求值并推送桌面链路清单（§5.2 exposure 定稿）
      await pushExposureToolsChanged('desktop')
    }
  )

  ipcMain.handle(
    'config:test-connection',
    async (
      _e,
      options?: {
        serviceId?: string
        apiKey?: string
        baseUrl?: string
        supportedModelIds?: string[]
        models?: ModelEntry[]
      }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!options?.serviceId) {
          return { success: false, error: '未指定大模型服务' }
        }
        if (options.supportedModelIds !== undefined && options.supportedModelIds.length === 0) {
          return { success: false, error: '该服务须至少支持一个模型' }
        }

        const creds = await resolveTestConnectionCredentials(ctx.db, options)
        if (creds.error || !creds.apiKey) {
          return { success: false, error: creds.error ?? ErrorCodes.API_KEY_NOT_CONFIGURED }
        }

        let models: ModelEntry[]
        if (options.models !== undefined) {
          models = Array.isArray(options.models) ? options.models : []
        } else {
          const rawModels = getConfigValue(ctx.db, CONFIG_KEYS.models)
          models = []
          if (rawModels) {
            try {
              models = JSON.parse(rawModels) as ModelEntry[]
            } catch {
              models = []
            }
          }
        }
        const enabledModel = resolveTestConnectionModel(ctx.db, models, options.serviceId, {
          supportedModelIds: options.supportedModelIds
        })
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

  ipcMain.handle(
    'llm:fetch-service-models',
    async (
      _e,
      options?: { serviceId?: string; apiKey?: string; baseUrl?: string }
    ): Promise<FetchServiceModelsResult> => {
      let creds: { apiKey: string | null; baseUrl: string | undefined; error?: string }
      try {
        creds = await resolveTestConnectionCredentials(ctx.db, options)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logAgentEvent('warn', 'llm.fetch_models', { success: false, error: message })
        return { ok: false, error: /baseurl/i.test(message) ? 'invalid-base-url' : 'network' }
      }
      try {
        if (creds.error || !creds.apiKey) return { ok: false, error: 'no-api-key' }
        const result = await fetchServiceModels({ baseUrl: creds.baseUrl, apiKey: creds.apiKey })
        logAgentEvent('info', 'llm.fetch_models', {
          success: result.ok,
          ...(result.ok
            ? { modelCount: result.models.length, truncated: result.truncated }
            : { error: result.error, status: 'status' in result ? result.status : undefined })
        })
        return result
      } catch (error) {
        logAgentEvent('warn', 'llm.fetch_models', {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        })
        return { ok: false, error: 'network' }
      }
    }
  )

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
