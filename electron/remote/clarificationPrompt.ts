import { formatClarificationHandle } from './clarificationHandle'
import type { ClarificationCandidate } from '../database/clarificationStore'

export function buildClarificationPrompt(handle: string, candidates: readonly ClarificationCandidate[]): string {
  return ['这条消息可能属于以下任务，请选择一个：', ...candidates.map((candidate) => `${candidate.option}. ${candidate.label}`),
    `请按「选择 ${formatClarificationHandle(handle)} <选项>」回复。此选择会继续处理你原来的消息。`].join('\n')
}
