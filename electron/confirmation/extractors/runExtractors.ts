import type {
  ContentFacts,
  EnvFacts,
  FactSignal,
  ToolActionDescriptor
} from '../../../src/shared/confirmation/types'
import { extractCommandSignals } from './commandSequenceExtractor'
import { buildPathSignal } from './pathClassifier'
import { extractScriptSignals } from './scriptAnalysisExtractor'

/** 主要工具专用的提取器（映射 descriptor.extractors 里声明的 id 到实际实现）。 */
const EXTRACTOR_IMPLEMENTATIONS: Record<
  string,
  (toolInput: Record<string, unknown>, env: EnvFacts) => { signals: FactSignal[]; summaryText: string }
> = {
  'command-sequence': (input, env) => {
    const command = typeof input.command === 'string' ? input.command : ''
    const r = extractCommandSignals(command, env)
    return { signals: r.signals, summaryText: r.summary.text }
  },
  'script-analysis': (input, env) => {
    const code = typeof input.code === 'string' ? input.code : ''
    const r = extractScriptSignals(code, env)
    return { signals: r.signals, summaryText: r.summary.text }
  },
  'path-classifier': (input, env) => {
    const rawPath = typeof input.path === 'string' ? input.path : ''
    if (!rawPath) return { signals: [], summaryText: '' }
    return { signals: [buildPathSignal(rawPath, env)], summaryText: `目标路径：${rawPath}` }
  }
}

/**
 * 编排提取器：按 descriptor 声明的 extractors 逐个运行，产出 ContentFacts。
 * 未实现的提取器不产生信号（信息缺省由默认策略兜底），已实现的分组语义见各提取器。
 */
export function runExtractors(
  descriptor: ToolActionDescriptor,
  toolInput: Record<string, unknown>,
  env: EnvFacts
): ContentFacts {
  const signals: FactSignal[] = []
  const summaryParts: string[] = []

  for (const name of descriptor.extractors) {
    const impl = EXTRACTOR_IMPLEMENTATIONS[name]
    if (!impl) continue
    const r = impl(toolInput, env)
    signals.push(...r.signals)
    if (r.summaryText) summaryParts.push(r.summaryText)
  }

  return {
    toolName: descriptor.toolName,
    actionClass: descriptor.actionClass,
    baseRiskLevel: descriptor.riskLevel,
    signals,
    summary: { text: summaryParts.length > 0 ? summaryParts.join('；') : '未识别到特殊风险，按默认策略判定' }
  }
}
