import type { CacheKey } from './types'

/**
 * 确认框架用户可见文案的集中点（M4）。
 *
 * i18n 说明：策略层/提取器位于主进程与共享层，无法访问渲染端 i18next（`t()`）。按 CLAUDE.md
 * 的 i18n 规范，用户可见文案不得散落硬编码。此处作为共享层/主进程的**显式豁免集中点**：
 * 集中放置种子文本与语义 key，后续由渲染侧 `t()` 映射到 zh-CN/en-US；在完成映射前，所有
 * 共享层/主进程的确认文案必须引用本模块，禁止散落字符串。
 */
export const CONFIRMATION_LABELS = {
  summaryDefault: '未识别到特殊风险，按默认策略判定',
  summaryEmptyCommand: '命令无法解析，需确认',
  summaryCommandSequencePrefix: '命令序列：',
  summaryPathTargetPrefix: '目标路径：',
  summaryCleanScript: '脚本静态分析未发现危险模式',
  summaryDangerousScript: '脚本含危险模式，已拒绝',
  summarySuspiciousScript: '脚本含需确认的危险模式',
  memoryTierPrefix: '记住',
  memoryTierGenericSuffix: '目标'
} as const

/** 记忆档位标签：用户可见，如实描述将记住的内容（最窄可用档）。 */
export function memoryTierLabel(key: CacheKey): string {
  if (key.kind === 'shell-command') {
    return `${CONFIRMATION_LABELS.memoryTierPrefix} ${key.verb}`
  }
  return `${CONFIRMATION_LABELS.memoryTierPrefix} ${key.kind} ${CONFIRMATION_LABELS.memoryTierGenericSuffix}`
}
