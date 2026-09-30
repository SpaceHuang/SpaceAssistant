import type { UsageAttributionCategory } from '../../../shared/usageStatsTypes'

/** 构成条与面积图共用的类别配色（单一来源，评审 P2：两图排序/配色不得漂移）。 */
export const ATTRIBUTION_CATEGORY_COLORS: Record<UsageAttributionCategory, string> = {
  system: '#5b8ff9',
  tools: '#f6903d',
  userText: '#61bf8f',
  assistantText: '#7f6be0',
  toolResults: '#d65f5f',
  assistantThinking: '#c084fc',
  assistantToolUse: '#e8a33d',
  other: '#8c8c8c'
}

/** 构成条与面积图共用的类别顺序（条形图段序 = 面积图堆叠序 = 图例序）。 */
export const ATTRIBUTION_CATEGORY_ORDER: UsageAttributionCategory[] = [
  'system',
  'tools',
  'userText',
  'assistantText',
  'toolResults',
  'assistantThinking',
  'assistantToolUse',
  'other'
]
