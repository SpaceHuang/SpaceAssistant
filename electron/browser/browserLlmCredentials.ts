import type { AppDatabase } from '../database'
import { getConfigValue } from '../database'
import type { BrowserConfig } from '../../src/shared/domainTypes'
import {
  getLlmServiceApiKey,
  readActiveLlmServiceId,
  readLlmServices
} from '../llmServiceResolver'
import type { StagehandCredentials } from './stagehandService'
import { buildStagehandInitModel } from './stagehandModelInit'

const DEFAULT_STAGEHAND_MODEL = 'anthropic/claude-sonnet-4-6'

export type StagehandModelConfig = {
  modelName: string
  apiKey: string
  baseURL?: string
}

/** Stagehand v3 要求 provider/model 格式，见 LLMProvider.getClient */
export function formatStagehandModelForV3(model: string, baseUrl?: string): string {
  const name = model.trim()
  if (!name) return DEFAULT_STAGEHAND_MODEL
  if (name.includes('/')) return name

  const lower = name.toLowerCase()
  const base = (baseUrl ?? '').toLowerCase()

  if (base.includes('deepseek.com') || base.includes('anthropic')) {
    return `anthropic/${name}`
  }
  if (lower.startsWith('claude')) {
    return `anthropic/${name}`
  }
  if (/^gpt-|^o[134]/.test(lower)) {
    return `openai/${name}`
  }
  if (lower.startsWith('gemini')) {
    return `google/${name}`
  }
  if (lower.includes('deepseek')) {
    return `deepseek/${name}`
  }

  return `anthropic/${name}`
}

export function buildStagehandModelConfig(
  model: string,
  apiKey: string,
  baseUrl?: string
): StagehandModelConfig {
  const cfg: StagehandModelConfig = {
    modelName: formatStagehandModelForV3(model, baseUrl),
    apiKey
  }
  const url = baseUrl?.trim()
  if (url) cfg.baseURL = url
  return cfg
}

export async function resolveStagehandCredentials(
  db: AppDatabase | undefined,
  config: BrowserConfig,
  fallbackModel?: string
): Promise<StagehandCredentials | null> {
  if (!db) return null
  const activeId = readActiveLlmServiceId(db)
  const services = readLlmServices(db)
  const active = services.find((s) => s.id === activeId) ?? services[0]
  if (!active) return null

  const apiKey = await getLlmServiceApiKey(db, active.id)
  if (!apiKey) return null

  let model = config.stagehandModel.trim()
  if (!model) {
    const chatModel = db ? getConfigValue(db, 'config.model') : undefined
    if (config.reuseActiveLlmProfile && chatModel?.trim()) {
      model = chatModel.trim()
    } else if (fallbackModel?.trim()) {
      model = fallbackModel.trim()
    } else {
      model = DEFAULT_STAGEHAND_MODEL
    }
  }

  const baseUrl = active.baseUrl?.trim() || undefined
  const modelConfig = buildStagehandModelConfig(model, apiKey, baseUrl)
  return {
    model: buildStagehandInitModel(modelConfig)
  }
}
