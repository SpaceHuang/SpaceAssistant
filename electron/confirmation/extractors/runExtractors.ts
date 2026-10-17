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
  (toolInput: Record<string, unknown>, env: EnvFacts, hostContext?: { trustedFeishuActorOpenId?: string }) => { signals: FactSignal[]; summaryText: string }
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
  'lark-subcommand': (input, _env, hostContext) => {
    const r = extractLarkSubcommand(input, hostContext?.trustedFeishuActorOpenId)
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

/**
 * 职责已收窄为「标记 grep 无法表达的 path 形状」（通配符与多路径字段），命中后目标被染成 unknown。
 * 目录 path 不在此列（目录递归已支持）；「V1 仅支持单文件」的旧职责已移除，
 * targetKind 契约由 readPolicyV1 / toolCallGate 按工具分别校验。
 */
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
  env: EnvFacts,
  hostContext?: { trustedFeishuActorOpenId?: string }
): ContentFacts {
  const signals: FactSignal[] = []
  const summaryParts: string[] = []

  for (const name of descriptor.extractors) {
    const impl = EXTRACTOR_IMPLEMENTATIONS[name]
    if (!impl) throw new Error(`UNIMPLEMENTED_FACT_EXTRACTOR:${name}`)
    const r = impl(toolInput, env, hostContext)
    signals.push(...r.signals)
    if (r.summaryText) summaryParts.push(r.summaryText)
  }

  const argv = toolInput.args
  const larkMessageOutbound = descriptor.toolName === 'run_lark_cli' && Array.isArray(argv) &&
    ['message', 'mail'].includes(String(argv[0] ?? '').toLowerCase()) &&
    ['send', 'create', 'reply'].includes(String(argv[1] ?? '').toLowerCase())
  return {
    toolName: descriptor.toolName,
    actionClass: larkMessageOutbound ? 'outbound' : descriptor.actionClass,
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
  env: EnvFacts & {
    userDataDir: string
    homeDir: string
    workDirs?: readonly string[]
    customSensitivePrefixes?: readonly string[]
    /** wiki 挂载锚点（T1.2，gate 以 resolveWikiMount 结果构造） */
    mountAnchors?: readonly import('./mountAnchors').MountAnchor[]
    /** wiki 敏感根豁免（T1.3，仅含共享库子树） */
    sensitiveRootExemptions?: readonly string[]
  }
): Promise<{ facts: ContentFacts; readPathFact: ReadPathFact }> {
  // path 省略时 grep 与 list_directory 一致，按工作目录根（'.'）探测——grep 递归搜索能力释放 §7.3
  const rawPath = extractPathField(toolInput)
    ?? (descriptor.toolName === 'list_directory' || descriptor.toolName === 'grep' ? '.' : '')
  const probedFact = await probeReadPathFact({
    rawPath,
    workDir: env.workDir,
    workDirs: env.workDirs,
    userDataDir: env.userDataDir,
    homeDir: env.homeDir,
    customSensitivePrefixes: env.customSensitivePrefixes ?? [],
    mountAnchors: env.mountAnchors,
    sensitiveRootExemptions: env.sensitiveRootExemptions
  })
  const readPathFact = descriptor.toolName === 'list_directory'
    ? { ...probedFact, scope: 'direct-entries-snapshot' as const }
    : hasUnsupportedV1ReadTarget(descriptor.toolName, toolInput)
    ? { ...probedFact, targetKind: 'unknown' as const, identity: undefined }
    : probedFact
  const facts = runExtractors(descriptor, toolInput, env)
  // T1.8④：审批卡片展示词汇路径（挂载命中时），真实 userData 路径不进渲染层
  facts.signals.push({ kind: 'path-target', path: readPathFact.vocabularyPath ?? readPathFact.normalizedPath, zone: readPathFact.zone })
  return { facts, readPathFact }
}
