/**
 * Agent Token 用量归因（按内容来源）——共享纯逻辑。
 *
 * 对应 docs/requirement/agent-token-usage-content-attribution-requirement.md：
 * - §7.2 messages 骨架：按 `<role>|<blockType>` 汇总的字典（仅 role/type/chars/tokens，永不落正文）
 * - §7.4 / AD15 / AD18：block-v1 整体重估三源（system / tools / messages），版本独立真列落位
 * - §6.3 约束 6：归一化采用 largest-remainder 舍入，保证 Σ归一化值 == 精确总量（AT7 / I4）
 * - §5.4 / AT12：skill 清单按 system 尾部 `## Skills` 区块切分（工具声明不误算进 skill 成本）
 */

/** 归因 JSON 列自身的 schema 版本（独立于数据库迁移版本，§7.2 设计要点）。 */
export const ATTRIBUTION_SCHEMA_VERSION = 1 as const

/** 整体重估估算器版本（AD18：命名保留 block-v1；落位为 usage_step_facts 真列 estimator_version）。 */
export const BLOCK_V1_ESTIMATOR_VERSION = 'block-v1'

/** 与 surfaceSnapshot 既有估算公式保持同源（default-v1 文本口径 ÷3.5），但产出随 block-v1 整体出版本。 */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

export type AttributionEntry = {
  /** UTF-16 字符数（【派生】口径；多模态 block 恒为 0，不伪造体积） */
  chars: number
  /** block-v1 估算 token；多模态/未启用估算时为 null（预留不伪造，§7.2 设计要点） */
  tokens: number | null
}

/** 键为 `<role>|<blockType>` 的按类型汇总字典（§7.2.2）。 */
export type MessageSkeletonBlocks = Record<string, AttributionEntry>

export type OutputSideSummary = {
  thinking: AttributionEntry
  text: AttributionEntry
  toolUseArgs: AttributionEntry
}

export type StepAttributionJson = {
  schemaVersion: typeof ATTRIBUTION_SCHEMA_VERSION
  blocks: MessageSkeletonBlocks
  /** 输出侧三类（SRC-D1）：本 step 响应的 thinking / 正文 / 工具调用参数 */
  output?: OutputSideSummary
}

export type BlockV1ThreeSources = {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
  /** 实际产出恒为 block-v1；类型放宽为 string 以支持从落库行重建归一化输入 */
  estimatorVersion: string
}

export type StepAttribution = StepAttributionJson & {
  /** 三源真列（SRC-A*）：与 blocks 同批（block-v1）产出，落 usage_step_facts 独立真列 */
  threeSources: BlockV1ThreeSources
}

/** 工具来源分组（§7.3：builtin / mcp / skill / other 的落盘形态取值）。 */
export type ToolSourceClass = 'builtin' | 'mcp' | 'skill' | 'other'

/** usage_turn_facts 归因 JSON 列形态（§7.6.5 / AD24）。 */
export type TurnToolDimension = {
  /** 按工具名的声明 schema 字符数（SRC-B3） */
  tools: Record<string, number>
  /** 按来源分组的声明 schema 字符数（SRC-B2） */
  toolSource: Record<string, number>
  /** 按工具名的调用次数与返回字符数（SRC-C1 / SRC-C2；SRC-B4 = tools ∖ toolResults） */
  toolResults: Record<string, { calls: number; chars: number }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** block 内容的字符数口径：text 取文本；tool_result 取其 content 文本；其余按 JSON 序列化。 */
function blockChars(block: Record<string, unknown>): number {
  const type = block.type
  if (type === 'text' || type === 'thinking') {
    const text = block.text ?? block.thinking
    return typeof text === 'string' ? text.length : 0
  }
  if (type === 'tool_use') {
    try {
      return JSON.stringify(block.input ?? {}).length
    } catch {
      return 0
    }
  }
  if (type === 'tool_result') {
    return toolResultContentChars(block.content)
  }
  if (type === 'image' || type === 'document' || type === 'audio') {
    // 多模态：字符口径恒 0（体积在源数据里，不伪造）；token 留 null（§7.2 多模态留位）
    return 0
  }
  try {
    return JSON.stringify(block).length
  } catch {
    return 0
  }
}

function toolResultContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let total = 0
    for (const block of content) {
      if (isRecord(block) && typeof block.text === 'string') total += block.text.length
      else if (isRecord(block)) total += blockChars(block)
    }
    return total
  }
  if (content == null) return 0
  try {
    return JSON.stringify(content).length
  } catch {
    return 0
  }
}

function addEntry(map: MessageSkeletonBlocks, key: string, chars: number, tokens: number | null): void {
  const existing = map[key]
  if (existing) {
    existing.chars += chars
    if (tokens != null) existing.tokens = (existing.tokens ?? 0) + tokens
  } else {
    map[key] = { chars, tokens }
  }
}

/**
 * §7.2.2：一次请求 messages 的按类型汇总骨架。
 * 字符数为【派生】口径；tokens 由调用方决定是否同批估算（P1 形态为 null）。
 */
export function buildMessageSkeleton(messages: readonly unknown[]): MessageSkeletonBlocks {
  const blocks: MessageSkeletonBlocks = {}
  for (const message of messages) {
    if (!isRecord(message)) continue
    const role = typeof message.role === 'string' ? message.role : 'unknown'
    const content = message.content
    if (typeof content === 'string') {
      addEntry(blocks, `${role}|text`, content.length, null)
      continue
    }
    if (Array.isArray(content)) {
      for (const raw of content) {
        if (!isRecord(raw)) continue
        const type = typeof raw.type === 'string' ? raw.type : 'unknown'
        addEntry(blocks, `${role}|${type}`, blockChars(raw), null)
      }
      continue
    }
    // content 缺失/非标准形态：按 0 字符的 text 记一条，保证该消息不静默消失（I5 不静默跳过）
    addEntry(blocks, `${role}|text`, 0, null)
  }
  return blocks
}

/** 输出侧三类字符统计（SRC-D1）。工具调用参数取自 content block 的 input，不依赖流式分片（§5.5）。 */
export function summarizeOutputBlocks(content: readonly unknown[]): OutputSideSummary {
  let thinking = 0
  let text = 0
  let toolUseArgs = 0
  for (const raw of content) {
    if (!isRecord(raw)) continue
    const type = raw.type
    if (type === 'thinking' && typeof raw.thinking === 'string') thinking += raw.thinking.length
    else if (type === 'text' && typeof raw.text === 'string') text += raw.text.length
    else if (type === 'tool_use') {
      try {
        toolUseArgs += JSON.stringify(raw.input ?? {}).length
      } catch {
        /* 序列化失败按 0 计 */
      }
    }
  }
  return {
    thinking: { chars: thinking, tokens: null },
    text: { chars: text, tokens: null },
    toolUseArgs: { chars: toolUseArgs, tokens: null }
  }
}

/** 工具来源分类：mcp_ 前缀 → mcp；其余内置（skills_* 是读技能的工具声明，不是 skill 定义，§5.4）。 */
export function classifyToolSource(name: string, explicit?: string): ToolSourceClass {
  if (explicit === 'mcp' || explicit === 'builtin' || explicit === 'skill' || explicit === 'other') return explicit
  return name.startsWith('mcp_') ? 'mcp' : 'builtin'
}

/** 按工具名统计声明 schema 字符数并按来源分组（SRC-B2 / SRC-B3 原料）。 */
export function summarizeToolDeclarations(tools: readonly unknown[]): {
  tools: Record<string, number>
  toolSource: Record<string, number>
} {
  const byName: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string') continue
    let chars = 0
    try {
      chars = JSON.stringify(tool).length
    } catch {
      continue
    }
    byName[tool.name] = (byName[tool.name] ?? 0) + chars
    const source = classifyToolSource(tool.name)
    bySource[source] = (bySource[source] ?? 0) + chars
  }
  return { tools: byName, toolSource: bySource }
}

export function emptyTurnToolDimension(): TurnToolDimension {
  return { tools: {}, toolSource: {}, toolResults: {} }
}

/** 把一次工具返回按工具名累计进 turn 维度（调用次数 + 返回字符数）。 */
export function accumulateToolResultVolume(dim: TurnToolDimension, toolName: string, content: unknown): void {
  const chars = toolResultContentChars(content)
  const entry = dim.toolResults[toolName] ?? { calls: 0, chars: 0 }
  entry.calls += 1
  entry.chars += chars
  dim.toolResults[toolName] = entry
}

export type SystemSkillSplit = {
  /** `## Skills` 之前的固定样板字符数 */
  baseChars: number
  /** skill 清单区块字符数（含 `## Skills` 标题行） */
  skillsChars: number
  /** 逐条 skill：名称 / 条目字符数 / read 路径（内联型为 null，§5.4 两种形态） */
  skills: Array<{ name: string; chars: number; readPath: string | null }>
}

/**
 * §5.4 / SRC-B5 / SRC-B6：system 尾部 skill 清单区块切分。
 * 位置以 `## Skills` 标记为准；skill 正文（SKILL.md）不在此处（走 skills_read 计入消息体）。
 */
export function splitSystemSkillSection(system: string): SystemSkillSplit | null {
  const marker = '## Skills'
  const idx = system.indexOf(marker)
  if (idx < 0) return null
  const skillsSection = system.slice(idx)
  const skills: SystemSkillSplit['skills'] = []
  // 条目形如 `- <name> (read: <path>) <desc>`；read 为空即内联型
  const entryRegex = /^-\s+(\S+)\s+\(read:\s*([^)]*)\)/gm
  let match: RegExpExecArray | null
  while ((match = entryRegex.exec(skillsSection)) !== null) {
    const start = match.index
    const next = skillsSection.indexOf('\n-', entryRegex.lastIndex)
    const end = next < 0 ? skillsSection.length : next
    skills.push({
      name: match[1]!,
      chars: end - start,
      readPath: match[2]!.trim().length > 0 ? match[2]!.trim() : null
    })
  }
  return { baseChars: idx, skillsChars: skillsSection.length, skills }
}

/** block-v1 整体重估三源（§7.4.1：必须整体覆盖，禁止与 default-v1 拼接）。 */
export function estimateBlockV1ThreeSources(args: {
  system: string
  tools: readonly unknown[]
  messages: readonly unknown[]
}): BlockV1ThreeSources {
  let toolsChars = 0
  try {
    toolsChars = JSON.stringify(args.tools).length
  } catch {
    toolsChars = 0
  }
  let messagesChars = 0
  for (const entry of Object.values(buildMessageSkeleton(args.messages))) messagesChars += entry.chars
  return {
    systemTokens: estimateTokens(args.system),
    toolsTokens: estimateTokensByChars(toolsChars),
    messageTokens: estimateTokensByChars(messagesChars),
    estimatorVersion: BLOCK_V1_ESTIMATOR_VERSION
  }
}

function estimateTokensByChars(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 3.5) : 0
}

function withTokens(chars: number): AttributionEntry {
  return { chars, tokens: estimateTokensByChars(chars) }
}

/**
 * 一次请求的完整归因（P2 目标形态）：blocks / 输出侧 / 三源真列同批（block-v1）产出。
 * 满足 §6.3 约束 5——归一化分子分母整体来自同一版本且覆盖全部三源。
 */
export function buildStepAttribution(args: {
  system: string
  tools: readonly unknown[]
  messages: readonly unknown[]
  outputContent?: readonly unknown[]
}): StepAttribution {
  const skeletonChars = buildMessageSkeleton(args.messages)
  const blocks: MessageSkeletonBlocks = {}
  for (const [key, entry] of Object.entries(skeletonChars)) {
    const multimodal = key.endsWith('|image') || key.endsWith('|document') || key.endsWith('|audio')
    blocks[key] = multimodal ? { chars: entry.chars, tokens: null } : withTokens(entry.chars)
  }
  const outputSummary = args.outputContent ? summarizeOutputBlocks(args.outputContent) : undefined
  const output: OutputSideSummary | undefined = outputSummary
    ? {
        thinking: withTokens(outputSummary.thinking.chars),
        text: withTokens(outputSummary.text.chars),
        toolUseArgs: withTokens(outputSummary.toolUseArgs.chars)
      }
    : undefined
  const json: StepAttributionJson = { schemaVersion: ATTRIBUTION_SCHEMA_VERSION, blocks, ...(output ? { output } : {}) }
  return { ...json, threeSources: estimateBlockV1ThreeSources(args) }
}

/**
 * §6.3 约束 6：largest-remainder 归一化舍入。
 * a. 各项取整 r_i = floor(weight_i / Σweight × total)
 * b. 余量 R = total − Σ r_i（0 ≤ R < 项数）
 * c. 按 (weight_i/Σweight × total − r_i) 小数部分降序补 1；并列按索引升序（确定性）。
 * 结果严格满足 Σ == total（AT7 / I4 的可断言恒等式）。
 */
export function normalizeTokensLargestRemainder(weights: readonly number[], exactTotal: number): number[] {
  const n = weights.length
  if (n === 0 || exactTotal <= 0) return new Array(n).fill(0)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  if (weightSum <= 0) return new Array(n).fill(0)
  const exact = weights.map((w) => (w / weightSum) * exactTotal)
  const floored = exact.map((v) => Math.floor(v))
  let remainder = exactTotal - floored.reduce((a, b) => a + b, 0)
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const result = floored.slice()
  for (const { i } of order) {
    if (remainder <= 0) break
    result[i]! += 1
    remainder -= 1
  }
  return result
}

export type NormalizedInputAttribution = {
  system: number
  tools: number
  /** 键与 blocks 一致；多模态（tokens null）按 0 摊回（留位不伪造） */
  messageBlocks: Record<string, number>
}

/**
 * §6.3 两段式归一化（输入侧）：估算层给结构占比，精确层给总量。
 * 分子分母整体来自同一 StepAttribution（block-v1，覆盖三源，I1/§6.3 约束 5）；
 * 精确总量 = input + cache_creation + cache_read（同一次请求，不跨请求混用）。
 * 结果满足 system + tools + ΣmessageBlocks == exactInputTokens（AT7 / I4）。
 */
export function normalizeInputAttribution(attribution: StepAttribution, exactInputTokens: number): NormalizedInputAttribution {
  const blockKeys = Object.keys(attribution.blocks)
  const weights: number[] = [attribution.threeSources.systemTokens, attribution.threeSources.toolsTokens]
  for (const key of blockKeys) weights.push(attribution.blocks[key]!.tokens ?? 0)
  const normalized = normalizeTokensLargestRemainder(weights, exactInputTokens)
  const messageBlocks: Record<string, number> = {}
  blockKeys.forEach((key, index) => {
    messageBlocks[key] = normalized[index + 2]!
  })
  return { system: normalized[0]!, tools: normalized[1]!, messageBlocks }
}

/**
 * 输出侧三类按精确 output_tokens 摊回（SRC-D1）。
 * Anthropic 不单列 thinking token（§4.3），三类占比来自本地估算、总量来自协议回报。
 */
export function normalizeOutputAttribution(
  attribution: StepAttribution,
  exactOutputTokens: number
): { thinking: number; text: number; toolUseArgs: number } {
  const output = attribution.output
  const normalized = normalizeTokensLargestRemainder(
    [output?.thinking.tokens ?? 0, output?.text.tokens ?? 0, output?.toolUseArgs.tokens ?? 0],
    exactOutputTokens
  )
  return { thinking: normalized[0]!, text: normalized[1]!, toolUseArgs: normalized[2]! }
}
