import type {
  ContentFacts,
  EnvFacts,
  FactSignal,
  ToolActionDescriptor
} from '../../../src/shared/confirmation/types'
import { CONFIRMATION_LABELS } from '../../../src/shared/confirmation/labels'
import { extractCommandSignals } from './commandSequenceExtractor'
import { buildPathSignal } from './pathClassifier'
import { extractScriptSignals } from './scriptAnalysisExtractor'
import { extractBrowserSignals } from './browserDomainExtractor'
import { extractOutboundTarget, extractLarkSubcommand } from './outboundExtractors'
import { extractToolkitCapability } from './toolkitCapabilityExtractor'
import { probeReadPathFact, type ReadPathFact } from './readPathFacts'
import { extractPathField } from '../../toolPathField'

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
  'browser-domain': (input, _env) => {
    const r = extractBrowserSignals(input, _env)
    return { signals: r.signals, summaryText: r.summary }
  },
  'outbound-target': (input) => {
    const r = extractOutboundTarget(input)
    return { signals: r.signals, summaryText: r.summary }
  },
  'lark-subcommand': (input) => {
    const r = extractLarkSubcommand(input)
    return { signals: r.signals, summaryText: r.summary }
  },
  'toolkit-capability': (input) => {
    const r = extractToolkitCapability(input)
    return { signals: r.signals, summaryText: r.summary }
  },
  'path-classifier': (input, env) => {
    const rawPath = typeof input.path === 'string' ? input.path : ''
    if (!rawPath) return { signals: [], summaryText: '' }
    return {
      signals: [buildPathSignal(rawPath, env)],
      summaryText: `${CONFIRMATION_LABELS.summaryPathTargetPrefix}${rawPath}`
    }
  }
}

export function assertExtractorsImplemented(descriptors: readonly ToolActionDescriptor[]): void {
  for (const descriptor of descriptors) {
    for (const name of descriptor.extractors) {
      if (!EXTRACTOR_IMPLEMENTATIONS[name]) throw new Error(`UNIMPLEMENTED_FACT_EXTRACTOR:${descriptor.toolName}:${name}`)
    }
  }
}

const MULTI_PATH_GREP_FIELDS = ['paths', 'files', 'filePaths', 'file_paths'] as const

export function hasUnsupportedV1ReadTarget(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== 'grep') return false
  const rawPath = extractPathField(toolInput)
  const hasWildcard = Boolean(rawPath && /[*?\[\]{}]/.test(rawPath))
  const hasMultipleTargets = MULTI_PATH_GREP_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(toolInput, field))
  return hasWildcard || hasMultipleTargets
}

/**
 * 编排提取器：按 descriptor 声明的 extractors 逐个运行，产出 ContentFacts。
 * 未实现的提取器是元数据契约错误，立即失败，避免安全事实声明静默失效。
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
    if (!impl) throw new Error(`UNIMPLEMENTED_FACT_EXTRACTOR:${name}`)
    const r = impl(toolInput, env)
    signals.push(...r.signals)
    if (r.summaryText) summaryParts.push(r.summaryText)
  }

  return {
    toolName: descriptor.toolName,
    actionClass: descriptor.actionClass,
    baseRiskLevel: descriptor.riskLevel,
    signals,
    summary: {
      text:
        summaryParts.length > 0 ? summaryParts.join('；') : CONFIRMATION_LABELS.summaryDefault
    }
  }
}

/** 读取工具的异步事实入口：先完成路径探测，再沿用既有 ContentFacts 编排结果。 */
export async function runExtractorsWithReadPathFact(
  descriptor: ToolActionDescriptor,
  toolInput: Record<string, unknown>,
  env: EnvFacts & { userDataDir: string; homeDir: string; customSensitivePrefixes?: readonly string[] }
): Promise<{ facts: ContentFacts; readPathFact: ReadPathFact }> {
  const rawPath = extractPathField(toolInput) ?? (descriptor.toolName === 'list_directory' ? '.' : '')
  const probedFact = await probeReadPathFact({
    rawPath,
    workDir: env.workDir,
    userDataDir: env.userDataDir,
    homeDir: env.homeDir,
    customSensitivePrefixes: env.customSensitivePrefixes ?? []
  })
  const readPathFact = descriptor.toolName === 'list_directory'
    ? { ...probedFact, scope: 'direct-entries-snapshot' as const }
    : hasUnsupportedV1ReadTarget(descriptor.toolName, toolInput)
    ? { ...probedFact, targetKind: 'unknown' as const, identity: undefined }
    : probedFact
  const facts = runExtractors(descriptor, toolInput, env)
  facts.signals.push({ kind: 'path-target', path: readPathFact.normalizedPath, zone: readPathFact.zone })
  return { facts, readPathFact }
}
