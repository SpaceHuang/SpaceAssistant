import type { AppConfig, Session } from '../../shared/domainTypes'
import {
  buildChatModelOptions,
  findChatModelOption,
  getAvailableModels,
  resolvePreferredModelEntry,
  type ChatModelOption
} from '../../shared/llmModelConfig'

export function resolveSessionModelBinding(
  cfg: AppConfig,
  session: Session | undefined
): { modelName: string; llmServiceId?: string; displayName: string; option?: ChatModelOption } {
  const activeIds =
    cfg.activeLlmServiceIds?.length > 0
      ? cfg.activeLlmServiceIds
      : cfg.activeLlmServiceId
        ? [cfg.activeLlmServiceId]
        : []

  const options = buildChatModelOptions(cfg.models, cfg.llmServices, activeIds)
  const available = getAvailableModels(cfg.models, cfg.llmServices, activeIds)

  if (session?.model) {
    const matched = findChatModelOption(options, session.llmServiceId, session.model)
    if (matched) {
      return {
        modelName: matched.modelName,
        llmServiceId: matched.serviceId,
        displayName: matched.displayName,
        option: matched
      }
    }
  }

  const preferred = resolvePreferredModelEntry(
    'language',
    cfg.models,
    available,
    cfg.preferredLanguageModelId ?? ''
  )
  if (preferred) {
    const matched = findChatModelOption(options, undefined, preferred.name)
    return {
      modelName: preferred.name,
      llmServiceId: matched?.serviceId,
      displayName: matched?.displayName ?? preferred.name,
      option: matched
    }
  }

  const fallback = options[0]
  return {
    modelName: fallback?.modelName ?? cfg.model,
    llmServiceId: fallback?.serviceId,
    displayName: fallback?.displayName ?? cfg.model,
    option: fallback
  }
}

export function listChatModelOptions(cfg: AppConfig): ChatModelOption[] {
  const activeIds =
    cfg.activeLlmServiceIds?.length > 0
      ? cfg.activeLlmServiceIds
      : cfg.activeLlmServiceId
        ? [cfg.activeLlmServiceId]
        : []
  return buildChatModelOptions(cfg.models, cfg.llmServices, activeIds)
}
