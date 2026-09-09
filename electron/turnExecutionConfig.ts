import type { TurnExecutionConfig } from '../src/shared/assistantFactAggregator'
import { isAppLocale } from '../src/shared/locale'
import { normalizeTurnExecutionConfig } from '../src/shared/turnCoordinator'
import type { ModelEntry } from '../src/shared/domainTypes'
import { resolveVisionRouteForImageSend } from '../src/shared/visionModelRouting'
import { getConfigValue, getSession, type AppDatabase } from './database'
import { readActiveLlmServiceIds, readLlmServices, resolveLlmCredentialsForModel } from './llmServiceResolver'

export type TurnExecutionLane = NonNullable<TurnExecutionConfig['lane']>

/**
 * 从主进程持有的 session / LLM service 配置生成不含凭据的执行快照。
 * 调用方只能补充由主进程构建的 system 等派生值，不能覆盖网络目标或模型绑定。
 */
export async function resolveTrustedTurnExecutionConfig(
  db: AppDatabase,
  sessionId: string,
  lane: TurnExecutionLane,
  derived: Pick<TurnExecutionConfig, 'system' | 'projectMemoryEnabled' | 'effectiveModelForUsage'> = {},
  options: { requiresVision?: boolean } = {}
): Promise<TurnExecutionConfig> {
  const session = getSession(db, sessionId)
  if (!session) throw new Error('TURN_SESSION_NOT_FOUND')
  let model = session.model.trim()
  if (!model) throw new Error('TURN_MODEL_NOT_CONFIGURED')
  let llmServiceId = session.llmServiceId
  let effectiveModelForUsage = derived.effectiveModelForUsage
  let models: ModelEntry[] = []
  try {
    const parsed = JSON.parse(getConfigValue(db, 'config.models') ?? '[]') as unknown
    if (Array.isArray(parsed)) models = parsed as ModelEntry[]
  } catch {
    models = []
  }
  if (options.requiresVision) {
    const activeLlmServiceIds = readActiveLlmServiceIds(db)
    const preferredVisionModelId = getConfigValue(db, 'config.preferredVisionModelId')
    const vision = resolveVisionRouteForImageSend({
      models,
      llmServices: readLlmServices(db),
      activeLlmServiceIds,
      activeLlmServiceId: activeLlmServiceIds[0],
      preferredVisionModelId: preferredVisionModelId ?? ''
    }, model, llmServiceId)
    if (!vision.ok) throw new Error('TURN_VISION_MODEL_NOT_CONFIGURED')
    if (vision.switched) effectiveModelForUsage = vision.modelName
    model = vision.modelName
    llmServiceId = vision.llmServiceId
  }
  const credentials = await resolveLlmCredentialsForModel(db, model, { serviceId: llmServiceId, models })
  const locale = getConfigValue(db, 'config.locale')
  return normalizeTurnExecutionConfig({
    lane,
    model,
    llmServiceId: credentials.serviceId || llmServiceId,
    baseUrl: credentials.baseUrl,
    maxTokens: session.maxTokens,
    enableThinking: getConfigValue(db, 'config.thinkingEnabled') !== 'false',
    ...(locale && isAppLocale(locale) ? { locale } : {}),
    ...derived,
    ...(effectiveModelForUsage ? { effectiveModelForUsage } : {})
  })
}
