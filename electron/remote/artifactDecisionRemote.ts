import type { ArtifactDecisionRequest } from '../../src/shared/artifactDecisionTypes'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Remote (IM) decision text codec.
 * Desktop path uses IPC `artifact:decision-request` / `artifact:decision-response`.
 * Keep this module the single codec for Feishu/WeChat inbound/outbound.
 */
export type ExtractedRemoteDecisionReply = {
  replyDecisionId?: string
  body: string
  hadUuidPrefix: boolean
}

export type ParsedArtifactDecisionBody =
  | { kind: 'choice'; choice: string }
  | { kind: 'usage_hint' }
  | { kind: 'not_decision' }

export type ParsedArtifactDecisionReply =
  | { kind: 'choice'; decisionId: string; choice: string }
  | { kind: 'usage_hint' }
  | { kind: 'not_decision' }

export function extractArtifactDecisionReplyPrefix(raw: string): ExtractedRemoteDecisionReply {
  const text = raw.trim()
  if (!text) return { body: '', hadUuidPrefix: false }
  const parts = text.split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ''
  if (!UUID_RE.test(first)) {
    return { body: text, hadUuidPrefix: false }
  }
  return {
    replyDecisionId: first.toLowerCase(),
    body: parts.slice(1).join(' '),
    hadUuidPrefix: true
  }
}

function encodeChoiceFromOption(
  option: ArtifactDecisionRequest['options'][number] | undefined,
  value: string
): string | undefined {
  if (!option) return undefined
  if (option.requiresInput === 'rename' && value) return `rename:${value}`
  if (option.requiresInput === 'directory' && value) {
    return `change-directory:${value.replace(/\\/g, '/').replace(/\/+$/, '')}`
  }
  return undefined
}

function valueHasUuidPollution(value: string): boolean {
  if (!value) return false
  const tokens = value.split(/\s+/).filter(Boolean)
  const first = tokens[0] ?? ''
  if (UUID_RE.test(first)) return true
  const hashMatch = value.match(/#([0-9a-fA-F-]{36})\s*$/)
  if (hashMatch?.[1] && UUID_RE.test(hashMatch[1])) return true
  return false
}

export function parseArtifactDecisionReplyBody(
  body: string,
  options: ArtifactDecisionRequest['options'],
  hadUuidPrefix: boolean
): ParsedArtifactDecisionBody {
  const text = body.trim()
  if (!text) return hadUuidPrefix ? { kind: 'usage_hint' } : { kind: 'not_decision' }
  const parts = text.split(/\s+/).filter(Boolean)
  const index = Number.parseInt(parts[0] ?? '', 10)
  if (!Number.isFinite(index) || index < 1 || String(index) !== (parts[0] ?? '')) {
    if (hadUuidPrefix) return { kind: 'usage_hint' }
    if (/^\d/.test(text)) return { kind: 'usage_hint' }
    return { kind: 'not_decision' }
  }
  if (index > options.length) return { kind: 'usage_hint' }
  const option = options[index - 1]
  const value = parts.slice(1).join(' ').trim()
  if (valueHasUuidPollution(value)) return { kind: 'usage_hint' }
  if (option?.requiresInput) {
    if (!value) return { kind: 'usage_hint' }
    const encoded = encodeChoiceFromOption(option, value)
    if (!encoded) return { kind: 'usage_hint' }
    return { kind: 'choice', choice: encoded }
  }
  if (value) return { kind: 'usage_hint' }
  return { kind: 'choice', choice: String(index) }
}

export function resolveRemoteArtifactDecisionChoice(
  request: ArtifactDecisionRequest,
  parsed: Extract<ParsedArtifactDecisionReply, { kind: 'choice' }>
): string {
  if (parsed.choice.startsWith('rename:') || parsed.choice.startsWith('change-directory:')) {
    return parsed.choice
  }
  const index = Number.parseInt(parsed.choice, 10)
  if (Number.isFinite(index) && index >= 1 && index <= request.options.length) {
    return request.options[index - 1]!.key
  }
  return parsed.choice
}

export function parseArtifactDecisionRemoteReply(
  raw: string,
  decisionId: string,
  optionCountOrOptions: number | ArtifactDecisionRequest['options'] = 4
): ParsedArtifactDecisionReply {
  const extracted = extractArtifactDecisionReplyPrefix(raw)
  const options = Array.isArray(optionCountOrOptions)
    ? optionCountOrOptions
    : Array.from({ length: typeof optionCountOrOptions === 'number' ? optionCountOrOptions : 4 }, (_, i) => {
        // Legacy overwrite shape when callers pass only a count.
        if (i === 1) return { key: 'rename', label: '改名', requiresInput: 'rename' as const }
        if (i === 2) return { key: 'change-directory', label: '改目录', requiresInput: 'directory' as const }
        if (i === 3) return { key: 'cancel', label: '取消' }
        return { key: 'overwrite', label: '覆盖' }
      })

  const parsed = parseArtifactDecisionReplyBody(extracted.body, options, extracted.hadUuidPrefix)
  if (parsed.kind !== 'choice') return parsed
  return {
    kind: 'choice',
    decisionId: extracted.replyDecisionId ?? decisionId,
    choice: parsed.choice
  }
}

function firstRequiresInputExample(options: ArtifactDecisionRequest['options']): {
  index: number
  placeholder: string
} | undefined {
  const index = options.findIndex((option) => option.requiresInput)
  if (index < 0) return undefined
  const option = options[index]!
  const placeholder = option.requiresInput === 'rename' ? 'review-v2.md' : 'reports/final'
  return { index: index + 1, placeholder }
}

export function serializeArtifactDecisionForRemote(request: ArtifactDecisionRequest): string {
  const lines = [
    `产物决策：${request.title ?? request.kind}`,
    `决策 ID：${request.decisionId}`,
    ...request.options.map(
      (option, index) =>
        `${index + 1}. ${option.label}${
          option.requiresInput === 'rename'
            ? '（需附带名称）'
            : option.requiresInput === 'directory'
              ? '（需附带目录）'
              : ''
        }`
    ),
    ''
  ]
  const valued = firstRequiresInputExample(request.options)
  if (valued) {
    lines.push(`单条待决时可回复：1 或 ${valued.index} ${valued.placeholder}`)
    lines.push(`若本私聊有多条待决，请回复：${request.decisionId} 1`)
    lines.push(`带值示例：${request.decisionId} ${valued.index} ${valued.placeholder}`)
  } else {
    lines.push('单条待决时可回复：1')
    lines.push(`若本私聊有多条待决，请回复：${request.decisionId} 1`)
  }
  return lines.join('\n')
}

export function buildArtifactDecisionUsageHint(
  options: ArtifactDecisionRequest['options']
): string {
  const valued = firstRequiresInputExample(options)
  if (!valued) {
    return '请回复编号选择，例如：1'
  }
  return `请回复编号选择。带值示例：${valued.index} ${valued.placeholder}`
}

export const ARTIFACT_DECISION_REMOTE_USAGE_HINT = buildArtifactDecisionUsageHint([
  { key: 'overwrite', label: '覆盖' },
  { key: 'rename', label: '改名', requiresInput: 'rename' },
  { key: 'change-directory', label: '改目录', requiresInput: 'directory' },
  { key: 'cancel', label: '取消' }
])

export function buildArtifactDecisionOptions(kind: ArtifactDecisionRequest['kind']): ArtifactDecisionRequest['options'] {
  switch (kind) {
    case 'path-type':
      return [
        { key: 'file', label: '文件' },
        { key: 'directory', label: '目录' }
      ]
    case 'output-location':
      return [{ key: 'custom', label: '指定输出路径', requiresInput: 'directory' }]
    case 'ownership':
      return [
        { key: 'project', label: '项目变更' },
        { key: 'package', label: '工作包' },
        { key: 'scratch', label: '草稿' }
      ]
    case 'overwrite':
      return [
        { key: 'overwrite', label: '覆盖' },
        { key: 'rename', label: '改名', requiresInput: 'rename' },
        { key: 'change-directory', label: '改目录', requiresInput: 'directory' },
        { key: 'cancel', label: '取消' }
      ]
    case 'reference-retention':
      return [
        { key: 'long-term', label: '长期保留' },
        { key: 'pending', label: '暂存' },
        { key: 'cancel', label: '取消' }
      ]
    case 'git-ignore':
      return [
        { key: 'add-ignore', label: '加入 .gitignore' },
        { key: 'keep-visible', label: '保持可见' },
        { key: 'cancel', label: '取消' }
      ]
    default:
      return []
  }
}
