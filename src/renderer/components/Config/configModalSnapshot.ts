import type {
  AppConfig,
  AppLocale,
  BrowserConfig,
  FeishuConfig,
  ModelEntry,
  ShellConfig,
  WikiConfig
} from '../../../shared/domainTypes'
import { DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'
import type { LlmServiceTabState } from './llmServiceDrafts'
import type { ToolsSettingsUi } from './ToolsSettingsTab'

export type ConfigModalSnapshotInput = {
  workDir: string
  locale: AppLocale
  thinkingEnabled: boolean
  models: ModelEntry[]
  llmState: LlmServiceTabState
  toolUi: ToolsSettingsUi
  maxParallelChatSessions: number
  wiki: WikiConfig
  feishu: FeishuConfig
  browser: BrowserConfig
  shell: ShellConfig
  shellEnabled: boolean
}

function normalizeModels(models: ModelEntry[]): ModelEntry[] {
  return [...models]
    .map((m) => ({
      id: m.id,
      name: m.name,
      maximumContext: m.maximumContext,
      maxTokens: m.maxTokens,
      isDefault: m.isDefault,
      isFast: m.isFast,
      enabled: m.enabled
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function normalizeLlmState(state: LlmServiceTabState) {
  return {
    activeId: state.activeId,
    order: [...state.order],
    drafts: state.order.map((id) => {
      const d = state.drafts[id]!
      return {
        id: d.id,
        name: d.name,
        baseUrl: d.baseUrl,
        apiKeyDraft: d.apiKeyDraft,
        isNew: Boolean(d.isNew)
      }
    })
  }
}

export function buildConfigModalSnapshot(input: ConfigModalSnapshotInput): string {
  const payload = {
    workDir: input.workDir.trim(),
    locale: input.locale,
    thinkingEnabled: input.thinkingEnabled,
    models: normalizeModels(input.models),
    llm: normalizeLlmState(input.llmState),
    toolUi: {
      confirmMode: input.toolUi.confirmMode,
      deniedTools: [...input.toolUi.deniedTools].sort(),
      pythonPath: input.toolUi.pythonPath,
      scriptTimeout: input.toolUi.scriptTimeout,
      fileCheckpointingEnabled: input.toolUi.fileCheckpointingEnabled,
      maxFileSnapshots: input.toolUi.maxFileSnapshots,
      grepTimeoutSec: input.toolUi.grepTimeoutSec
    },
    maxParallelChatSessions: input.maxParallelChatSessions,
    wiki: input.wiki,
    feishu: input.feishu,
    browser: { ...input.browser, allowedDomains: [] },
    shell: { ...input.shell, enabled: input.shellEnabled }
  }
  return JSON.stringify(payload)
}

export function buildConfigModalSnapshotFromConfig(
  cfg: AppConfig,
  llmState: LlmServiceTabState,
  deniedTools: string[],
  shellEnabled: boolean
): string {
  const browserCfg = cfg.browser ?? { enabled: true, trustedDomains: [], allowedDomains: [] }
  const trustedDomains = [
    ...new Set([...(browserCfg.trustedDomains ?? []), ...(browserCfg.allowedDomains ?? [])])
  ]
  return buildConfigModalSnapshot({
    workDir: cfg.workDir,
    locale: cfg.locale,
    thinkingEnabled: cfg.thinkingEnabled,
    models: cfg.models,
    llmState,
    toolUi: {
      confirmMode: cfg.tools.confirmMode,
      deniedTools,
      pythonPath: cfg.tools.pythonPath,
      scriptTimeout: cfg.tools.scriptTimeout,
      fileCheckpointingEnabled: cfg.tools.fileCheckpointingEnabled,
      maxFileSnapshots: cfg.tools.maxFileSnapshots,
      grepTimeoutSec: cfg.tools.grepTimeoutSec
    },
    maxParallelChatSessions: cfg.maxParallelChatSessions,
    wiki: cfg.wiki,
    feishu: cfg.feishu,
    browser: { ...browserCfg, enabled: true, trustedDomains, allowedDomains: [] },
    shell: cfg.shell ?? { ...DEFAULT_SHELL_CONFIG, enabled: shellEnabled },
    shellEnabled
  })
}

export function configModalSnapshotsEqual(a: string, b: string): boolean {
  return a === b
}

/** 将 deep link / 旧 Tab key 映射到当前设置 Tab */
export function normalizeSettingsTabKey(tab?: string): string | undefined {
  if (!tab) return undefined
  if (tab === 'browser') return 'tools'
  if (tab === 'llm-service' || tab === 'llm-defaults') return 'models'
  return tab
}
