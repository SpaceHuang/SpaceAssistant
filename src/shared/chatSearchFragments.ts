import type { DisplayOrder } from './displayOrder'
import type { Message, ToolCallRecord, ToolCallResultPersisted } from './domainTypes'
import { contentSegmentsForRender } from './contentSegments'
import { thinkingSegmentsForRender } from './thinkingSegments'
import { formatToolLabel, type ToolCallLabelT } from './toolCallLabel'
import { projectShellOutput } from './terminalOutputSanitize'

export type SearchSource =
  | { kind: 'user-content' }
  | { kind: 'assistant-markdown-text'; segmentIndex: number; fragmentIndex: number }
  | { kind: 'assistant-code'; segmentIndex: number; codeIndex: number; inline: boolean }
  | { kind: 'assistant-math'; segmentIndex: number; mathIndex: number; display: boolean }
  | { kind: 'thinking'; segmentIndex: number }
  | { kind: 'skill'; hintId: string }
  | { kind: 'tool-label'; toolUseId: string }
  | { kind: 'tool-input'; toolUseId: string }
  | { kind: 'tool-result'; toolUseId: string }

export type SearchRevealPath = {
  batchKey?: string
  thinkingSegmentIndex?: number
  toolUseId?: string
  toolSection?: 'input' | 'result'
}

export type SearchTextAnchor = {
  textStart: number
  textEnd: number
  nodeKey: string
  nodeTextStart: number
}

type SearchFragmentBase = {
  fragmentId: string
  messageId: string
  order: DisplayOrder
  source: SearchSource
  revealPath?: SearchRevealPath
}

export type SearchFragment =
  | (SearchFragmentBase & {
      renderStrategy: 'anchored-text'
      searchableText: string
      anchors: SearchTextAnchor[]
    })
  | (SearchFragmentBase & {
      renderStrategy: 'code-source'
      searchableText: string
    })
  | (SearchFragmentBase & {
      renderStrategy: 'math-source'
      searchableText: string
    })

export type ChatSearchMatch = {
  fragmentId: string
  messageId: string
  order: DisplayOrder
  start: number
  end: number
}

export type MarkdownSearchProjectionInput = {
  plainTextFragments: Array<{
    segmentIndex: number
    fragmentIndex: number
    searchableText: string
    anchors: SearchTextAnchor[]
  }>
  codeFragments: Array<{
    segmentIndex: number
    codeIndex: number
    inline: boolean
    searchableText: string
  }>
  mathFragments: Array<{
    segmentIndex: number
    mathIndex: number
    display: boolean
    searchableText: string
  }>
}

export type BuildSearchFragmentsOptions = {
  t?: ToolCallLabelT
  projectMarkdown?: (markdown: string, segmentIndex: number) => MarkdownSearchProjectionInput
}

const defaultT: ToolCallLabelT = (key) => key

function sourceIdentityKey(source: SearchSource): string {
  switch (source.kind) {
    case 'user-content':
      return 'user-content'
    case 'assistant-markdown-text':
      return `assistant-markdown-text:${source.segmentIndex}:${source.fragmentIndex}`
    case 'assistant-code':
      return `assistant-code:${source.segmentIndex}:${source.codeIndex}:${source.inline ? 'inline' : 'block'}`
    case 'assistant-math':
      return `assistant-math:${source.segmentIndex}:${source.mathIndex}:${source.display ? 'display' : 'inline'}`
    case 'thinking':
      return `thinking:${source.segmentIndex}`
    case 'skill':
      return `skill:${source.hintId}`
    case 'tool-label':
      return `tool-label:${source.toolUseId}`
    case 'tool-input':
      return `tool-input:${source.toolUseId}`
    case 'tool-result':
      return `tool-result:${source.toolUseId}`
  }
}

/** 由 messageId 与 source 身份确定性生成 fragmentId。 */
export function buildFragmentId(messageId: string, source: SearchSource): string {
  return `${messageId}|${sourceIdentityKey(source)}`
}

function simplifyToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

function simplifyToolResult(result: ToolCallResultPersisted | undefined, toolName?: string): string {
  if (!result) return ''
  if (result.data == null) return result.error ?? ''
  if ((toolName === 'run_shell' || toolName === 'run_script') && typeof result.data === 'object') {
    const output = result.data as { stdout?: unknown; stderr?: unknown; exitCode?: unknown; terminalScrollback?: unknown }
    const exitCode = typeof output.exitCode === 'number' && Number.isFinite(output.exitCode) ? output.exitCode : undefined
    const visible = projectShellOutput(String(output.stdout ?? ''), String(output.stderr ?? ''), exitCode)
    if (visible) return visible
    const scrollback = output.terminalScrollback as { plainText?: unknown; ansiText?: unknown } | undefined
    const fallback = String(scrollback?.plainText ?? scrollback?.ansiText ?? '')
    if (fallback) return projectShellOutput(fallback, '', undefined)
    if (result.error) return result.error
    return ''
  }
  if (result.error) return result.error
  if (typeof result.data === 'string') return result.data
  try {
    return JSON.stringify(result.data, null, 2)
  } catch {
    return String(result.data)
  }
}

function isStreamingAssistant(message: Message): boolean {
  return message.role === 'assistant' && (message.status === 'streaming' || message.status === 'sending')
}

function pushAnchoredTextFragment(
  out: SearchFragment[],
  messageId: string,
  order: DisplayOrder,
  source: SearchSource,
  searchableText: string,
  revealPath?: SearchRevealPath,
  anchors: SearchTextAnchor[] = [],
  preserveWhitespace = false
): void {
  const text = preserveWhitespace ? searchableText : searchableText.trim()
  if (!text) return
  out.push({
    fragmentId: buildFragmentId(messageId, source),
    messageId,
    order,
    source,
    revealPath,
    renderStrategy: 'anchored-text',
    searchableText: text,
    anchors
  })
}

function appendAssistantContentFragments(
  out: SearchFragment[],
  message: Message,
  order: DisplayOrder,
  options: BuildSearchFragmentsOptions
): void {
  const segments = contentSegmentsForRender(message)
  const projectMarkdown = options.projectMarkdown

  segments.forEach((segment, segmentIndex) => {
    const content = segment.content
    if (!content.trim()) return

    if (isStreamingAssistant(message) || !projectMarkdown) {
      pushAnchoredTextFragment(
        out,
        message.id,
        order,
        { kind: 'assistant-markdown-text', segmentIndex, fragmentIndex: 0 },
        content
      )
      return
    }

    const projection = projectMarkdown(content, segmentIndex)

    for (const plain of projection.plainTextFragments) {
      pushAnchoredTextFragment(
        out,
        message.id,
        order,
        {
          kind: 'assistant-markdown-text',
          segmentIndex: plain.segmentIndex,
          fragmentIndex: plain.fragmentIndex
        },
        plain.searchableText,
        undefined,
        plain.anchors
      )
    }

    for (const code of projection.codeFragments) {
      const source: SearchSource = {
        kind: 'assistant-code',
        segmentIndex: code.segmentIndex,
        codeIndex: code.codeIndex,
        inline: code.inline
      }
      const text = code.searchableText.trim()
      if (!text) continue
      out.push({
        fragmentId: buildFragmentId(message.id, source),
        messageId: message.id,
        order,
        source,
        renderStrategy: 'code-source',
        searchableText: text
      })
    }

    for (const math of projection.mathFragments) {
      const source: SearchSource = {
        kind: 'assistant-math',
        segmentIndex: math.segmentIndex,
        mathIndex: math.mathIndex,
        display: math.display
      }
      const text = math.searchableText.trim()
      if (!text) continue
      out.push({
        fragmentId: buildFragmentId(message.id, source),
        messageId: message.id,
        order,
        source,
        renderStrategy: 'math-source',
        searchableText: text
      })
    }
  })
}

function appendThinkingFragments(out: SearchFragment[], message: Message, order: DisplayOrder): void {
  if (!message.thinking) return
  const segments = thinkingSegmentsForRender(message.thinking)
  segments.forEach((segment, segmentIndex) => {
    pushAnchoredTextFragment(
      out,
      message.id,
      order,
      { kind: 'thinking', segmentIndex },
      segment.content,
      { thinkingSegmentIndex: segmentIndex }
    )
  })
}

function appendSkillFragments(out: SearchFragment[], message: Message, order: DisplayOrder): void {
  for (const hint of message.skillHints ?? []) {
    pushAnchoredTextFragment(
      out,
      message.id,
      order,
      { kind: 'skill', hintId: hint.id },
      hint.text
    )
  }
}

function appendToolFragments(
  out: SearchFragment[],
  message: Message,
  order: DisplayOrder,
  t: ToolCallLabelT
): void {
  for (const tool of message.toolCalls ?? []) {
    appendToolRecordFragments(out, message.id, order, tool, t)
  }
}

function appendToolRecordFragments(
  out: SearchFragment[],
  messageId: string,
  order: DisplayOrder,
  tool: ToolCallRecord,
  t: ToolCallLabelT
): void {
  const revealBase: SearchRevealPath = { toolUseId: tool.id }

  pushAnchoredTextFragment(
    out,
    messageId,
    order,
    { kind: 'tool-label', toolUseId: tool.id },
    formatToolLabel(tool.toolName, tool.input, t),
    revealBase
  )

  const inputText = simplifyToolInput(tool.input)
  if (inputText.trim()) {
    pushAnchoredTextFragment(
      out,
      messageId,
      order,
      { kind: 'tool-input', toolUseId: tool.id },
      inputText,
      { ...revealBase, toolSection: 'input' }
    )
  }

  const resultText = simplifyToolResult(tool.result, tool.toolName)
  if (resultText.trim()) {
    pushAnchoredTextFragment(
      out,
      messageId,
      order,
      { kind: 'tool-result', toolUseId: tool.id },
      resultText,
      { ...revealBase, toolSection: 'result' },
      [],
      tool.toolName === 'run_shell' || tool.toolName === 'run_script'
    )
  }
}

/** 从单条消息与其展示顺序生成结构化搜索片段。 */
export function buildSearchFragmentsFromMessage(
  message: Message,
  order: DisplayOrder,
  options: BuildSearchFragmentsOptions = {}
): SearchFragment[] {
  const t = options.t ?? defaultT
  const out: SearchFragment[] = []

  if (message.role === 'user') {
    pushAnchoredTextFragment(out, message.id, order, { kind: 'user-content' }, message.content)
    return out
  }

  if (message.role === 'assistant') {
    appendThinkingFragments(out, message, order)
    appendSkillFragments(out, message, order)
    appendAssistantContentFragments(out, message, order, options)
    appendToolFragments(out, message, order, t)
  }

  return out
}

export function buildSearchFragmentsFromMessages(
  entries: Array<{ message: Message; order: DisplayOrder }>,
  options: BuildSearchFragmentsOptions = {}
): SearchFragment[] {
  return entries.flatMap(({ message, order }) => buildSearchFragmentsFromMessage(message, order, options))
}
