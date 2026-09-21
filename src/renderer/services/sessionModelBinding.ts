import type { AgentReasoningEffort } from '../../shared/agent/invocation'
import type { AppConfig, Session } from '../../shared/domainTypes'
import {
  buildChatModelOptions,
  findChatModelOption,
  getAvailableModels,
  resolvePreferredModelEntry,
  type ChatModelOption
} from '../../shared/llmModelConfig'
import { isThinkingEffort, normalizeThinkingEffort } from '../../shared/thinkingEffort'

/** 会话级 Thinking 强度绑定（需求 §5.2）：继承语义 + composer 草稿保持，与 resolveSessionModelBinding 同构。 */
export function resolveSessionThinkingBinding(
  cfg: AppConfig,
  session: Session | undefined,
  draftEffort?: AgentReasoningEffort
): { effort: AgentReasoningEffort; overridden: boolean; globalEffort: AgentReasoningEffort } {
  const globalEffort = normalizeThinkingEffort(cfg.thinkingEffort, 'medium')
  if (!session) {
    // composer 在首个会话创建前渲染：草稿选择视为覆盖，随会话创建一并写入
    return isThinkingEffort(draftEffort)
      ? { effort: draftEffort, overridden: true, globalEffort }
      : { effort: globalEffort, overridden: false, globalEffort }
  }
  if (isThinkingEffort(session.thinkingEffort)) {
    return { effort: session.thinkingEffort, overridden: true, globalEffort }
  }
  // undefined / null / 损坏值 = 未覆盖，每次解析读全局当前值（继承而非快照，§4.2）
  return { effort: globalEffort, overridden: false, globalEffort }
}

export function resolveSessionModelBinding(
  cfg: AppConfig,
  session: Session | undefined,
  draftOption?: ChatModelOption
): { modelName: string; llmServiceId?: string; displayName: string; option?: ChatModelOption } {
  const activeIds =
    cfg.activeLlmServiceIds?.length > 0
      ? cfg.activeLlmServiceIds
      : cfg.activeLlmServiceId
        ? [cfg.activeLlmServiceId]
        : []

  const options = buildChatModelOptions(cfg.models, cfg.llmServices, activeIds)
  const available = getAvailableModels(cfg.models, cfg.llmServices, activeIds)

  // The composer is also rendered before the first session exists. Preserve a
  // model selected there so the eventual session is created with that choice.
  if (!session && draftOption) {
    return {
      modelName: draftOption.modelName,
      llmServiceId: draftOption.serviceId,
      displayName: draftOption.displayName,
      option: draftOption
    }
  }

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
