import rawBaseline from '../../res/resource/model-baseline.json'
import type { AgentReasoningEffort } from './agent/invocation'
import { MODEL_PARAMETER_OVERRIDES, UNRESOLVED_MODEL_VISION_OVERRIDES } from './modelBaselineOverrides'

export type ThinkingLevelMap = Partial<Record<AgentReasoningEffort | 'minimal' | 'max', string | null>>

export type ModelBaselineEntry = {
  maximumContext: number
  maxTokens: number
  isVision: boolean
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
  sourceProvider: string
}

export const MODEL_BASELINE = rawBaseline.models as Record<string, ModelBaselineEntry>

/** 仅保留 pi-ai 静态目录暂未覆盖的既有内置模型参数。 */
export const LEGACY_MODEL_PARAMS: Record<string, Pick<ModelBaselineEntry, 'maximumContext' | 'maxTokens' | 'isVision'>> = {}

export { UNRESOLVED_MODEL_VISION_OVERRIDES }
export { MODEL_PARAMETER_OVERRIDES }

export function getModelBaseline(name: string): ModelBaselineEntry | undefined {
  return MODEL_BASELINE[name]
}

export function getEffectiveModelBaseline(name: string): ModelBaselineEntry | undefined {
  const baseline = getModelBaseline(name)
  if (!baseline) return undefined
  return { ...baseline, ...MODEL_PARAMETER_OVERRIDES[name] }
}

/** UI/runtime 视觉资格直接取 pi-ai 的 input=image 能力，不读应用侧的手工标签。 */
export function isPiAiVisionModel(name: string): boolean {
  return getModelBaseline(name)?.isVision === true
}
