import type { ArtifactDecisionRequest } from '../../src/shared/artifactDecisionTypes'

/**
 * Remote (IM) decision text codec.
 * Desktop path uses IPC `artifact:decision-request` / `artifact:decision-response`.
 * Feishu/WeChat inbound reply → parse → submitArtifactDecisionResponse is not wired yet;
 * keep this module the single codec when that integration lands.
 */
export function serializeArtifactDecisionForRemote(request: ArtifactDecisionRequest): string {
  const header = [`决策 ${request.decisionId}`, request.title ?? request.kind, request.message ?? ''].filter(Boolean).join('\n')
  const options = request.options
    .map((option, index) => `${index + 1}. ${option.label}${option.requiresInput ? '（回复时附带值）' : ''}`)
    .join('\n')
  return `${header}\n${options}\n回复编号或「编号 值」，例如：1 或 2 review-v2.md`
}

export type ParsedArtifactDecisionReply =
  | { kind: 'choice'; decisionId: string; choice: string }
  | { kind: 'usage_hint' }
  | { kind: 'not_decision' }

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
  const options = Array.isArray(optionCountOrOptions) ? optionCountOrOptions : undefined
  const optionCount = options?.length ?? (typeof optionCountOrOptions === 'number' ? optionCountOrOptions : 4)
  const text = raw.trim()
  if (!text) return { kind: 'not_decision' }
  const parts = text.split(/\s+/).filter(Boolean)
  const index = Number.parseInt(parts[0] ?? '', 10)
  if (!Number.isFinite(index) || index < 1) {
    if (/^\d/.test(text)) return { kind: 'usage_hint' }
    return { kind: 'not_decision' }
  }
  if (index > optionCount) return { kind: 'usage_hint' }
  const value = parts.slice(1).join(' ').trim()
  if (options) {
    const encoded = encodeChoiceFromOption(options[index - 1], value)
    if (encoded) return { kind: 'choice', decisionId, choice: encoded }
  } else {
    // Legacy overwrite indices when callers omit options.
    if (index === 2 && value) return { kind: 'choice', decisionId, choice: `rename:${value}` }
    if (index === 3 && value) {
      return { kind: 'choice', decisionId, choice: `change-directory:${value.replace(/\\/g, '/').replace(/\/+$/, '')}` }
    }
  }
  return { kind: 'choice', decisionId, choice: String(index) }
}

export const ARTIFACT_DECISION_REMOTE_USAGE_HINT =
  '请回复编号选择。改名示例：2 review-v2.md；改目录示例：3 reports/final/'

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
