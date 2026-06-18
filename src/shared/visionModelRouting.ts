import type { AppConfig, Message, ModelEntry } from './domainTypes'
import {
  buildChatModelOptions,
  findChatModelOption,
  normalizeModelEntry,
  resolvePreferredModelEntry,
  type ChatModelOption
} from './llmModelConfig'
import { filterMessagesForChatApi } from './chatMessageQueue'
import { messageHasImageAttachments } from './claudeToolHistory'

export { messageHasImageAttachments }

export type VisionRouteResult =
  | { ok: true; switched: boolean; modelName: string; llmServiceId: string | undefined; displayName: string }
  | { ok: false }

function activeServiceIds(cfg: AppConfig): string[] {
  if (cfg.activeLlmServiceIds?.length) return cfg.activeLlmServiceIds
  return cfg.activeLlmServiceId ? [cfg.activeLlmServiceId] : []
}

/** 多服务同名视觉模型时按 activeServiceIds 顺序取第一项（§4.2） */
export function findVisionModelOption(
  options: ChatModelOption[],
  modelName: string,
  serviceIds: string[]
): ChatModelOption | undefined {
  const matches = options.filter((o) => o.modelName === modelName && o.model.isVision)
  if (matches.length === 0) return undefined
  if (matches.length === 1) return matches[0]
  for (const serviceId of serviceIds) {
    const found = matches.find((o) => o.serviceId === serviceId)
    if (found) return found
  }
  return matches[0]
}

export function resolveVisionModelBinding(
  cfg: AppConfig,
  options: ChatModelOption[]
): { modelName: string; llmServiceId: string; displayName: string; model: ModelEntry } | null {
  const normalized = cfg.models.map((m) => normalizeModelEntry(m))
  const available = normalized.filter((m) => m.enabled && m.isVision && options.some((o) => o.modelId === m.id))
  if (available.length === 0) return null

  const preferred = resolvePreferredModelEntry('vision', normalized, available, cfg.preferredVisionModelId ?? '')
  if (!preferred) return null

  const matched = findVisionModelOption(options, preferred.name, activeServiceIds(cfg))
  if (!matched) return null

  return {
    modelName: matched.modelName,
    llmServiceId: matched.serviceId,
    displayName: matched.displayName,
    model: matched.model
  }
}

export function listChatModelOptionsFromConfig(cfg: AppConfig): ChatModelOption[] {
  return buildChatModelOptions(cfg.models, cfg.llmServices, activeServiceIds(cfg))
}

/** 带图发送时的视觉模型路由：已选手动视觉模型时不阻塞；非视觉 session 强制切视觉优选 */
export function resolveVisionRouteForImageSend(
  cfg: AppConfig,
  sessionModelName: string,
  sessionLlmServiceId: string | undefined
): VisionRouteResult {
  const options = listChatModelOptionsFromConfig(cfg)
  const sessionModel = cfg.models.map((m) => normalizeModelEntry(m)).find((m) => m.name === sessionModelName)
  const sessionOption = sessionLlmServiceId
    ? findChatModelOption(options, sessionLlmServiceId, sessionModelName)
    : findVisionModelOption(options, sessionModelName, activeServiceIds(cfg))

  if (sessionModel?.isVision && sessionOption?.model.isVision) {
    return {
      ok: true,
      switched: false,
      modelName: sessionModelName,
      llmServiceId: sessionLlmServiceId,
      displayName: sessionOption.displayName
    }
  }

  const vision = resolveVisionModelBinding(cfg, options)
  if (!vision) return { ok: false }

  return {
    ok: true,
    switched: !sessionModel?.isVision,
    modelName: vision.modelName,
    llmServiceId: vision.llmServiceId,
    displayName: vision.displayName
  }
}

export function currentUserMessageHasImages(messages: Message[], currentUserMessageId: string): boolean {
  const msg = messages.find((m) => m.id === currentUserMessageId)
  return msg ? messageHasImageAttachments(msg) : false
}

/** history 中是否存在带图 user 消息 */
export function historyHasImageAttachments(messages: Message[]): boolean {
  return messages.some((m) => messageHasImageAttachments(m))
}

/** 将进入 API 的 history 是否含图片（含历史轮次） */
export function requestNeedsVisionModel(historyForApi: Message[]): boolean {
  return filterMessagesForChatApi(historyForApi).some(messageHasImageAttachments)
}
