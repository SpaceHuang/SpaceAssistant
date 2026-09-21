import type { TurnExecutionConfig } from '../src/shared/assistantFactAggregator'
import { isAppLocale } from '../src/shared/locale'
import { normalizeTurnExecutionConfig } from '../src/shared/turnCoordinator'
import type { ModelEntry } from '../src/shared/domainTypes'
import type { AgentReasoningEffort } from '../src/shared/agent/invocation'
import { resolveGlobalThinkingEffort } from '../src/shared/thinkingEffort'
import { getAvailableModels, migrateBuiltinModelName, resolvePreferredModelEntry } from '../src/shared/llmModelConfig'
import { resolveVisionRouteForImageSend } from '../src/shared/visionModelRouting'
import { logAgentEvent } from './agentLogger/agentLogger'
import { getConfigValue, getSession, updateSession, type AppDatabase } from './database'
import { readActiveLlmServiceIds, readLlmServices, readStoredModels, resolveLlmCredentialsForModel } from './llmServiceResolver'

export type TurnExecutionLane = NonNullable<TurnExecutionConfig['lane']>

/**
 * Thinking 强度最终解析（需求 §7.1）：
 * 能力校验（显式 false → off）优先于优先级；其余按「会话覆盖 > 全局默认」。
 */
export function resolveThinkingEffort(
  globalEffort: AgentReasoningEffort,
  sessionEffort: AgentReasoningEffort | null | undefined,
  modelEntry: ModelEntry | undefined
): AgentReasoningEffort {
  if (modelEntry?.supportsThinking === false) return 'off'
  return sessionEffort ?? globalEffort
}

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
  const storedModel = session.model.trim()
  if (!storedModel) throw new Error('TURN_MODEL_NOT_CONFIGURED')
  let model = storedModel
  let llmServiceId = session.llmServiceId
  let effectiveModelForUsage = derived.effectiveModelForUsage

  const models: ModelEntry[] = readStoredModels(db)

  // ① 旧内置名（kimi-k2.6 / glm-5.1 / deepseek-v4-flash…）先归一到当前名并回写：
  //    否则请求会带着已不存在的模型名发出，凭据解析也会直接失败。
  const migratedName = migrateBuiltinModelName(storedModel)
  if (migratedName !== storedModel) {
    model = migratedName
    updateSession(db, sessionId, { model: migratedName })
    logAgentEvent('info', 'session.model.migrated', { sessionId, lane, from: storedModel, to: migratedName })
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
  let credentials = await resolveLlmCredentialsForModel(db, model, { serviceId: llmServiceId, models })

  // ② 模型被下架 / 已无可用服务时，重绑到当前优选模型并回写，避免历史会话永久失败。
  //    渲染层本就把不可用模型显示成回退模型，这里把主进程的真实绑定对齐到同一模型。
  //    带图 turn 例外：此时的 model 是 per-turn 派生的视觉模型（见上），与用户会话绑定无关。
  //    从 language 组重绑会把图片发给非视觉模型，还会把「视觉服务缺 Key」的配置事故静默记到
  //    会话绑定上（effectiveModelForUsage 也仍停在视觉模型名），所以只允许 fail-fast。
  if (credentials.error && !options.requiresVision) {
    const available = getAvailableModels(models, readLlmServices(db), readActiveLlmServiceIds(db))
    const preferred = resolvePreferredModelEntry(
      'language',
      models,
      available,
      getConfigValue(db, 'config.preferredLanguageModelId') ?? ''
    )
    if (preferred && preferred.name !== model) {
      const rebound = await resolveLlmCredentialsForModel(db, preferred.name, { models })
      if (!rebound.error) {
        logAgentEvent('warn', 'session.model.rebound', {
          sessionId,
          lane,
          from: model,
          to: preferred.name,
          reason: credentials.error
        })
        model = preferred.name
        llmServiceId = rebound.serviceId || undefined
        credentials = rebound
        // 解析成功时必带 serviceId（只有失败才是空串）：显式覆盖旧绑定，
        // 避免下一轮继续拿过期 serviceId 解析失败再重绑一次。
        updateSession(db, sessionId, { model, llmServiceId: rebound.serviceId })
      }
    }
  }

  // ③ fail-fast：解析不出端点就不放行。否则 SDK 会退回默认端点，用一个不相干的服务地址
  //    把「模型不可用」伪装成远端 403，用户只看到「回复未能完成」。
  if (credentials.error) {
    if (options.requiresVision) {
      throw new Error(
        `视觉模型「${model}」当前不可用（${credentials.error}），请在设置中重新选择视觉模型或补齐 API 服务配置`
      )
    }
    throw new Error(
      `会话模型「${model}」当前不可用（${credentials.error}），请在设置中重新选择模型或补齐 API 服务配置`
    )
  }

  const modelEntry = models.find((entry) => entry.name === model)
  const locale = getConfigValue(db, 'config.locale')
  // Thinking 强度（§7.1）：迁移期双读（新键缺失由旧布尔推导，读兜底不落库）+ 会话覆盖 + 能力降级；
  // enableThinking 由最终档位派生（过渡期兼容字段，保留一个发布周期）。
  // 评审 B1：能力降级时额外携带降级前档位（requestedThinkingEffort），主链路把它传给装配器，
  // 由装配层照旧落 agent.profile.reasoning_degraded 审计——降级不能在装配前「静默」发生。
  const requestedThinkingEffort = resolveThinkingEffort(
    resolveGlobalThinkingEffort(
      getConfigValue(db, 'config.thinkingEffort'),
      getConfigValue(db, 'config.thinkingEnabled')
    ),
    session.thinkingEffort,
    undefined
  )
  const thinkingEffort = resolveThinkingEffort(
    resolveGlobalThinkingEffort(
      getConfigValue(db, 'config.thinkingEffort'),
      getConfigValue(db, 'config.thinkingEnabled')
    ),
    session.thinkingEffort,
    modelEntry
  )
  return normalizeTurnExecutionConfig({
    lane,
    model,
    ...(modelEntry?.maximumContext ? { maximumContext: modelEntry.maximumContext } : {}),
    llmServiceId: credentials.serviceId || llmServiceId,
    maxTokens: session.maxTokens,
    thinkingEffort,
    ...(thinkingEffort !== requestedThinkingEffort ? { requestedThinkingEffort } : {}),
    enableThinking: thinkingEffort !== 'off',
    ...(locale && isAppLocale(locale) ? { locale } : {}),
    ...derived,
    ...(effectiveModelForUsage ? { effectiveModelForUsage } : {})
  })
}
